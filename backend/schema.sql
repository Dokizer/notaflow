-- NotaFlow: initial schema for one private account per Supabase Auth login.
-- Run once in a fresh Supabase project using its SQL Editor as the project owner.
BEGIN;

CREATE TABLE public.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  name text NOT NULL DEFAULT 'Meu controle' CHECK (name = 'Meu controle'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  client_name text NOT NULL CHECK (char_length(btrim(client_name)) BETWEEN 1 AND 160 AND client_name !~ '[[:cntrl:]]'),
  nf_number text NOT NULL CHECK (char_length(btrim(nf_number)) BETWEEN 1 AND 80 AND nf_number !~ '[[:cntrl:]]'),
  billing_date date NOT NULL CHECK (billing_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  term_days integer NOT NULL CHECK (term_days BETWEEN 0 AND 3650),
  consultant text NOT NULL CHECK (consultant IN ('Raimundo Sergio','Rogerio Luiz','Fabio Araujo','Bartolomeu Gonçalves','Thiago Nogueira')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 99999999999),
  funding_source text NOT NULL CHECK (funding_source IN ('bank','own')),
  bank_name text NOT NULL CHECK ((funding_source='bank' AND char_length(btrim(bank_name)) BETWEEN 1 AND 80 AND bank_name !~ '[[:cntrl:]]') OR (funding_source='own' AND bank_name='')),
  paid_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_workspace_updated_idx ON public.invoices(workspace_id,updated_at DESC,id);
-- invoice_id deliberately has no foreign key: deleting a note retains its identity.
CREATE TABLE public.invoice_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  client_name text NOT NULL,
  nf_number text NOT NULL,
  action text NOT NULL CHECK (action IN ('created','updated','paid','reopened','deleted')),
  details jsonb NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX invoice_events_workspace_created_idx ON public.invoice_events(workspace_id,created_at DESC,id DESC);

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_account_read ON public.workspaces FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY own_invoices_read ON public.invoices FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = workspace_id AND w.owner_id = (SELECT auth.uid()))
);
CREATE POLICY own_events_read ON public.invoice_events FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = workspace_id AND w.owner_id = (SELECT auth.uid()))
);
REVOKE ALL ON public.workspaces,public.invoices,public.invoice_events FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON public.workspaces,public.invoices,public.invoice_events TO authenticated;
REVOKE ALL ON SEQUENCE public.invoice_events_id_seq FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.nf_immutable_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'NF_IMMUTABLE' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON public.invoice_events
FOR EACH ROW EXECUTE FUNCTION public.nf_immutable_history();
CREATE TRIGGER immutable_history_truncate BEFORE TRUNCATE ON public.invoice_events
FOR EACH STATEMENT EXECUTE FUNCTION public.nf_immutable_history();

CREATE FUNCTION public.nf_audit_invoice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_row public.invoices; v_action text; v_details jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE = '42501'; END IF;
  IF TG_OP = 'INSERT' THEN v_row := NEW; v_action := 'created'; v_details := jsonb_build_object('after',to_jsonb(NEW));
  ELSIF TG_OP = 'DELETE' THEN v_row := OLD; v_action := 'deleted'; v_details := jsonb_build_object('before',to_jsonb(OLD));
  ELSE
    v_row := NEW;
    v_action := CASE WHEN OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL THEN 'paid'
      WHEN OLD.paid_at IS NOT NULL AND NEW.paid_at IS NULL THEN 'reopened' ELSE 'updated' END;
    v_details := jsonb_build_object('before',to_jsonb(OLD),'after',to_jsonb(NEW));
  END IF;
  INSERT INTO public.invoice_events(invoice_id,workspace_id,client_name,nf_number,action,details,actor_id)
  VALUES (v_row.id,v_row.workspace_id,v_row.client_name,v_row.nf_number,v_action,v_details,auth.uid());
  RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER audit_invoice AFTER INSERT OR UPDATE OR DELETE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.nf_audit_invoice();

CREATE FUNCTION public.ensure_account() RETURNS public.workspaces
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_user uuid := auth.uid(); v_row public.workspaces;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.workspaces(owner_id) VALUES(v_user) ON CONFLICT(owner_id) DO NOTHING;
  SELECT * INTO STRICT v_row FROM public.workspaces WHERE owner_id = v_user;
  RETURN v_row;
END;
$$;

CREATE FUNCTION public.save_invoice(p_invoice jsonb,p_expected_version integer) RETURNS public.invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_user uuid := auth.uid(); v_id uuid; v_workspace uuid; v_date date;
  v_term integer; v_amount bigint; v_row public.invoices;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE = '42501'; END IF;
  IF p_invoice IS NULL OR jsonb_typeof(p_invoice) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_invoice) AS k WHERE k NOT IN
    ('id','workspace_id','client_name','nf_number','billing_date','term_days','consultant','amount_cents','funding_source','bank_name')
  ) THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['workspace_id','client_name','nf_number','billing_date','consultant','funding_source','bank_name']) k
    WHERE jsonb_typeof(p_invoice->k) IS DISTINCT FROM 'string')
    OR jsonb_typeof(p_invoice->'term_days') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_invoice->'amount_cents') IS DISTINCT FROM 'number'
    OR (p_invoice->>'term_days') !~ '^[0-9]{1,4}$'
    OR (p_invoice->>'amount_cents') !~ '^[0-9]{1,11}$'
    OR (p_invoice->>'workspace_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR ((p_invoice ? 'id') AND (jsonb_typeof(p_invoice->'id') IS DISTINCT FROM 'string' OR (p_invoice->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR (p_expected_version IS NOT NULL AND (p_expected_version < 1 OR p_expected_version > 2147483646 OR NOT (p_invoice ? 'id')))
    OR char_length(btrim(p_invoice->>'client_name')) NOT BETWEEN 1 AND 160 OR (p_invoice->>'client_name') ~ '[[:cntrl:]]'
    OR char_length(btrim(p_invoice->>'nf_number')) NOT BETWEEN 1 AND 80 OR (p_invoice->>'nf_number') ~ '[[:cntrl:]]'
    OR (p_invoice->>'billing_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR (p_invoice->>'consultant') NOT IN ('Raimundo Sergio','Rogerio Luiz','Fabio Araujo','Bartolomeu Gonçalves','Thiago Nogueira')
    OR (p_invoice->>'funding_source') NOT IN ('bank','own')
    OR ((p_invoice->>'funding_source')='bank' AND (char_length(btrim(p_invoice->>'bank_name')) NOT BETWEEN 1 AND 80 OR (p_invoice->>'bank_name') ~ '[[:cntrl:]]'))
    OR ((p_invoice->>'funding_source')='own' AND (p_invoice->>'bank_name')<>'')
  THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE = '22023'; END IF;
  BEGIN
    v_date := (p_invoice->>'billing_date')::date;
    v_term := (p_invoice->>'term_days')::integer;
    v_amount := (p_invoice->>'amount_cents')::bigint;
    v_workspace := (p_invoice->>'workspace_id')::uuid;
    v_id := COALESCE((p_invoice->>'id')::uuid,gen_random_uuid());
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE = '22023';
  END;
  IF v_date NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' OR v_term NOT BETWEEN 0 AND 3650 OR v_amount NOT BETWEEN 1 AND 99999999999
  THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id=v_workspace AND owner_id=v_user)
  THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE = '42501'; END IF;
  IF p_expected_version IS NULL THEN
    BEGIN
      INSERT INTO public.invoices(id,workspace_id,client_name,nf_number,billing_date,term_days,consultant,amount_cents,funding_source,bank_name)
      VALUES(v_id,v_workspace,btrim(p_invoice->>'client_name'),btrim(p_invoice->>'nf_number'),v_date,v_term,p_invoice->>'consultant',v_amount,p_invoice->>'funding_source',btrim(p_invoice->>'bank_name')) RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'NF_CONFLICT' USING ERRCODE = '40001'; END;
  ELSE
    SELECT * INTO v_row FROM public.invoices WHERE id=v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NF_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
    IF v_row.workspace_id<>v_workspace OR NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id=v_row.workspace_id AND owner_id=v_user)
    THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE = '42501'; END IF;
    IF v_row.version<>p_expected_version THEN RAISE EXCEPTION 'NF_CONFLICT' USING ERRCODE = '40001'; END IF;
    UPDATE public.invoices SET client_name=btrim(p_invoice->>'client_name'),nf_number=btrim(p_invoice->>'nf_number'),billing_date=v_date,term_days=v_term,
      consultant=p_invoice->>'consultant',amount_cents=v_amount,funding_source=p_invoice->>'funding_source',bank_name=btrim(p_invoice->>'bank_name'),
      version=version+1,updated_at=clock_timestamp() WHERE id=v_id RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END;
$$;

CREATE FUNCTION public.set_invoice_paid(p_id uuid,p_paid boolean,p_expected_version integer) RETURNS public.invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_user uuid := auth.uid(); v_row public.invoices;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE = '42501'; END IF;
  IF p_id IS NULL OR p_paid IS NULL OR p_expected_version IS NULL OR p_expected_version NOT BETWEEN 1 AND 2147483646
  THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_row FROM public.invoices WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NF_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=v_row.workspace_id AND owner_id=v_user)
  THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE = '42501'; END IF;
  IF v_row.version<>p_expected_version THEN RAISE EXCEPTION 'NF_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF (v_row.paid_at IS NOT NULL)=p_paid THEN RETURN v_row; END IF;
  UPDATE public.invoices SET paid_at=CASE WHEN p_paid THEN clock_timestamp() ELSE NULL END,
    version=version+1,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE FUNCTION public.delete_invoice(p_id uuid,p_expected_version integer) RETURNS public.invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_user uuid := auth.uid(); v_row public.invoices;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE = '42501'; END IF;
  IF p_id IS NULL OR p_expected_version IS NULL OR p_expected_version NOT BETWEEN 1 AND 2147483646
  THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_row FROM public.invoices WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NF_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=v_row.workspace_id AND owner_id=v_user)
  THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE = '42501'; END IF;
  IF v_row.version<>p_expected_version THEN RAISE EXCEPTION 'NF_CONFLICT' USING ERRCODE = '40001'; END IF;
  DELETE FROM public.invoices WHERE id=p_id;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.nf_immutable_history(), public.nf_audit_invoice(), public.ensure_account(),
  public.save_invoice(jsonb,integer),public.set_invoice_paid(uuid,boolean,integer),public.delete_invoice(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_account(),public.save_invoice(jsonb,integer),
  public.set_invoice_paid(uuid,boolean,integer),public.delete_invoice(uuid,integer) TO authenticated;
COMMIT;
