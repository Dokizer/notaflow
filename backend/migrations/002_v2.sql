-- Apply ONCE after schema.sql (1.1), including for a populated database.
-- No legacy invoice row or historical event is rewritten by this migration.
BEGIN;

CREATE FUNCTION public.nf_normalize(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  -- ECMAScript whitespace, including NBSP/BOM, matches the local parser/core key.
  SELECT lower(btrim(regexp_replace(regexp_replace(normalize(p_text,NFD),'[̀-ͯ]','','g'),U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',' ','g')))
$$;
CREATE FUNCTION public.nf_duplicate_key(p_client text,p_nf text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT jsonb_build_array(public.nf_normalize(p_client),CASE WHEN public.nf_normalize(p_nf) ~ '^[0-9]+$'
    THEN coalesce(nullif(ltrim(public.nf_normalize(p_nf),'0'),''),'0') ELSE public.nf_normalize(p_nf) END)::text
$$;
CREATE FUNCTION public.nf_require_account(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF auth.uid() IS NULL OR p_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=p_id AND owner_id=auth.uid())
  THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
END;
$$;

CREATE FUNCTION public.nf_validate_invoice_input(p_invoice jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE v_date date;v_due date;v_term integer;v_amount bigint;
BEGIN
  IF p_invoice IS NULL OR jsonb_typeof(p_invoice)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_invoice) k WHERE k NOT IN ('id','workspace_id','client_name','nf_number','billing_date','term_days','due_date','consultant','consultant_id','client_id','amount_cents','funding_source','bank_name'))
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['workspace_id','client_name','nf_number','billing_date','consultant','funding_source','bank_name']) k WHERE jsonb_typeof(p_invoice->k) IS DISTINCT FROM 'string')
    OR jsonb_typeof(p_invoice->'term_days') IS DISTINCT FROM 'number' OR (p_invoice->>'term_days') !~ '^[0-9]{1,4}$'
    OR jsonb_typeof(p_invoice->'amount_cents') IS DISTINCT FROM 'number' OR (p_invoice->>'amount_cents') !~ '^[0-9]{1,11}$'
    OR char_length(btrim(p_invoice->>'client_name')) NOT BETWEEN 1 AND 160 OR p_invoice->>'client_name' ~ '[[:cntrl:]]'
    OR char_length(btrim(p_invoice->>'nf_number')) NOT BETWEEN 1 AND 80 OR p_invoice->>'nf_number' ~ '[[:cntrl:]]'
    OR char_length(p_invoice->>'consultant')>160 OR p_invoice->>'consultant' ~ '[[:cntrl:]]'
    OR p_invoice->>'funding_source' NOT IN ('bank','own','unspecified')
    OR (p_invoice->>'funding_source'='bank' AND (char_length(btrim(p_invoice->>'bank_name')) NOT BETWEEN 1 AND 80 OR p_invoice->>'bank_name' ~ '[[:cntrl:]]'))
    OR (p_invoice->>'funding_source' IN ('own','unspecified') AND p_invoice->>'bank_name'<>'')
    OR p_invoice->>'billing_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR (p_invoice->>'due_date' IS NOT NULL AND (jsonb_typeof(p_invoice->'due_date')<>'string' OR p_invoice->>'due_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['id','workspace_id','consultant_id','client_id']) k WHERE p_invoice->>k IS NOT NULL AND (jsonb_typeof(p_invoice->k)<>'string' OR p_invoice->>k !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR (p_invoice?'id' AND p_invoice->>'id' IS NULL)
  THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023'; END IF;
  v_date:=(p_invoice->>'billing_date')::date;v_due:=(p_invoice->>'due_date')::date;v_term:=(p_invoice->>'term_days')::integer;v_amount:=(p_invoice->>'amount_cents')::bigint;
  IF v_date NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' OR v_term NOT BETWEEN 0 AND 3650 OR v_amount NOT BETWEEN 1 AND 99999999999 OR (v_due IS NOT NULL AND (v_due<>v_date+v_term OR v_due NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31')) THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023'; END IF;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023';
END;
$$;

CREATE TABLE public.consultants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 160 AND name !~ '[[:cntrl:]]'),
  phone text NOT NULL DEFAULT '' CHECK(phone='' OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  email text NOT NULL DEFAULT '' CHECK(email='' OR (char_length(email)<=254 AND email !~ '[[:cntrl:]]' AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  active boolean NOT NULL DEFAULT true,
  notifications_enabled boolean NOT NULL DEFAULT true,
  whatsapp_authorized boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id)
);
CREATE UNIQUE INDEX consultants_workspace_name_idx ON public.consultants(workspace_id,public.nf_normalize(name));
CREATE TABLE public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 160 AND name !~ '[[:cntrl:]]'),
  consultant_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),FOREIGN KEY(workspace_id,consultant_id) REFERENCES public.consultants(workspace_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX clients_workspace_name_idx ON public.clients(workspace_id,public.nf_normalize(name));

ALTER TABLE public.invoices DROP CONSTRAINT invoices_consultant_check,
  DROP CONSTRAINT invoices_funding_source_check,DROP CONSTRAINT invoices_check,
  ADD CONSTRAINT invoices_consultant_v2_check CHECK(char_length(consultant)<=160 AND consultant !~ '[[:cntrl:]]'),
  ADD CONSTRAINT invoices_funding_v2_check CHECK(funding_source IN ('bank','own','unspecified')),
  ADD CONSTRAINT invoices_bank_v2_check CHECK((funding_source='bank' AND char_length(btrim(bank_name)) BETWEEN 1 AND 80 AND bank_name !~ '[[:cntrl:]]') OR (funding_source IN ('own','unspecified') AND bank_name='')),
  ADD COLUMN due_date date CHECK(due_date IS NULL OR (due_date BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' AND due_date=billing_date+term_days)),
  ADD COLUMN consultant_id uuid,ADD COLUMN client_id uuid,ADD COLUMN cancelled_at timestamptz,
  ADD CONSTRAINT invoices_no_paid_cancelled CHECK(paid_at IS NULL OR cancelled_at IS NULL),
  ADD CONSTRAINT invoices_workspace_id_unique UNIQUE(workspace_id,id),
  ADD CONSTRAINT invoices_consultant_account_fk FOREIGN KEY(workspace_id,consultant_id) REFERENCES public.consultants(workspace_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT invoices_client_account_fk FOREIGN KEY(workspace_id,client_id) REFERENCES public.clients(workspace_id,id) ON DELETE RESTRICT;
-- Nonunique: old installations may legitimately contain duplicates.
CREATE INDEX invoices_duplicate_lookup_idx ON public.invoices(workspace_id,public.nf_duplicate_key(client_name,nf_number));
ALTER TABLE public.invoice_events DROP CONSTRAINT invoice_events_action_check,
  ADD CONSTRAINT invoice_events_action_check CHECK(action IN ('created','updated','paid','reopened','deleted','cancelled','restored'));

CREATE TABLE public.billing_settings (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  rules jsonb NOT NULL DEFAULT '{"before_days":1,"on_due":true,"after_days":1,"repeat_days":3,"hour":9,"daily_summary":true}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.imports (
  id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  file_name text NOT NULL CHECK(char_length(btrim(file_name)) BETWEEN 1 AND 255 AND file_name !~ '[[:cntrl:]]'),
  total_count integer NOT NULL CHECK(total_count BETWEEN 0 AND 5000),
  imported_count integer NOT NULL CHECK(imported_count>=0),duplicate_count integer NOT NULL CHECK(duplicate_count>=0),
  error_count integer NOT NULL CHECK(error_count>=0),ignored_count integer NOT NULL CHECK(ignored_count>=0),
  status text NOT NULL CHECK(status IN ('completed','partial','failed')),
  request_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(total_count=imported_count+duplicate_count+error_count+ignored_count),UNIQUE(workspace_id,id)
);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  -- Identity is retained after invoice deletion, just like invoice_events.
  invoice_id uuid NOT NULL,consultant_id uuid NOT NULL,
  channel text NOT NULL CHECK(channel='whatsapp_manual'),
  status text NOT NULL CHECK(status IN ('prepared','confirmed_by_user','failed')),
  message text NOT NULL CHECK(char_length(message) BETWEEN 1 AND 6000),
  phone text NOT NULL CHECK(phone ~ '^\+[1-9][0-9]{7,14}$'),
  error text CHECK(error IS NULL OR (char_length(error)<=500 AND error !~ '[[:cntrl:]]')),
  created_at timestamptz NOT NULL DEFAULT now(),confirmed_at timestamptz,
  CHECK((status='confirmed_by_user')=(confirmed_at IS NOT NULL)),
  FOREIGN KEY(workspace_id,consultant_id) REFERENCES public.consultants(workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX notifications_workspace_created_idx ON public.notifications(workspace_id,created_at DESC,id);
CREATE TABLE public.entity_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  entity text NOT NULL,entity_id uuid NOT NULL,action text NOT NULL,details jsonb NOT NULL,
  actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Seeds do not alter invoice IDs, versions or historical names.
INSERT INTO public.consultants(workspace_id,name)
SELECT w.id,n.name FROM public.workspaces w CROSS JOIN unnest(ARRAY['Raimundo Sergio','Rogerio Luiz','Fabio Araujo','Bartolomeu Gonçalves','Thiago Nogueira']) AS n(name);
INSERT INTO public.billing_settings(workspace_id) SELECT id FROM public.workspaces;
INSERT INTO public.clients(workspace_id,name)
SELECT DISTINCT ON (workspace_id,public.nf_normalize(client_name)) workspace_id,client_name FROM public.invoices ORDER BY workspace_id,public.nf_normalize(client_name),id;

CREATE FUNCTION public.nf_audit_entity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_row jsonb:=to_jsonb(NEW);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
  INSERT INTO public.entity_events(workspace_id,entity,entity_id,action,details,actor_id)
  VALUES((v_row->>'workspace_id')::uuid,TG_TABLE_NAME,coalesce((v_row->>'id')::uuid,(v_row->>'workspace_id')::uuid),lower(TG_OP),
    CASE WHEN TG_OP='INSERT' THEN jsonb_build_object('after',v_row) ELSE jsonb_build_object('before',to_jsonb(OLD),'after',v_row) END,auth.uid());
  RETURN NEW;
END;
$$;
CREATE TRIGGER audit_consultants AFTER INSERT OR UPDATE ON public.consultants FOR EACH ROW EXECUTE FUNCTION public.nf_audit_entity();
CREATE TRIGGER audit_clients AFTER INSERT OR UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION public.nf_audit_entity();
CREATE TRIGGER audit_settings AFTER INSERT OR UPDATE ON public.billing_settings FOR EACH ROW EXECUTE FUNCTION public.nf_audit_entity();
CREATE TRIGGER audit_imports AFTER INSERT ON public.imports FOR EACH ROW EXECUTE FUNCTION public.nf_audit_entity();
CREATE TRIGGER audit_notifications AFTER INSERT OR UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.nf_audit_entity();
CREATE TRIGGER immutable_imports BEFORE UPDATE OR DELETE ON public.imports FOR EACH ROW EXECUTE FUNCTION public.nf_immutable_history();
CREATE TRIGGER immutable_imports_truncate BEFORE TRUNCATE ON public.imports FOR EACH STATEMENT EXECUTE FUNCTION public.nf_immutable_history();
CREATE TRIGGER immutable_entities BEFORE UPDATE OR DELETE ON public.entity_events FOR EACH ROW EXECUTE FUNCTION public.nf_immutable_history();
CREATE TRIGGER immutable_entities_truncate BEFORE TRUNCATE ON public.entity_events FOR EACH STATEMENT EXECUTE FUNCTION public.nf_immutable_history();

CREATE OR REPLACE FUNCTION public.ensure_account() RETURNS public.workspaces
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_user uuid:=auth.uid();v_row public.workspaces;v_created boolean;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
  INSERT INTO public.workspaces(owner_id) VALUES(v_user) ON CONFLICT(owner_id) DO NOTHING RETURNING * INTO v_row;
  v_created:=FOUND;
  IF NOT v_created THEN SELECT * INTO STRICT v_row FROM public.workspaces WHERE owner_id=v_user; END IF;
  IF v_created THEN
    INSERT INTO public.consultants(workspace_id,name) SELECT v_row.id,n FROM unnest(ARRAY['Raimundo Sergio','Rogerio Luiz','Fabio Araujo','Bartolomeu Gonçalves','Thiago Nogueira']) n;
    INSERT INTO public.billing_settings(workspace_id) VALUES(v_row.id);
  END IF;
  RETURN v_row;
END;
$$;

CREATE FUNCTION public.save_consultant(p_consultant jsonb,p_expected_version integer) RETURNS public.consultants
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_workspace uuid;v_id uuid;v_row public.consultants;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
  IF p_consultant IS NULL OR jsonb_typeof(p_consultant)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_consultant) k WHERE k NOT IN ('id','workspace_id','name','phone','email','active','notifications_enabled','whatsapp_authorized'))
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['workspace_id','name','phone','email']) k WHERE jsonb_typeof(p_consultant->k) IS DISTINCT FROM 'string')
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['active','notifications_enabled','whatsapp_authorized']) k WHERE jsonb_typeof(p_consultant->k) IS DISTINCT FROM 'boolean')
    OR (p_expected_version IS NOT NULL AND (p_expected_version NOT BETWEEN 1 AND 2147483646 OR NOT(p_consultant?'id')))
  THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023'; END IF;
  BEGIN v_workspace:=(p_consultant->>'workspace_id')::uuid;v_id:=coalesce((p_consultant->>'id')::uuid,gen_random_uuid());
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023'; END;
  PERFORM public.nf_require_account(v_workspace);
  IF p_expected_version IS NULL THEN
    BEGIN INSERT INTO public.consultants(id,workspace_id,name,phone,email,active,notifications_enabled,whatsapp_authorized)
      VALUES(v_id,v_workspace,btrim(p_consultant->>'name'),p_consultant->>'phone',btrim(p_consultant->>'email'),(p_consultant->>'active')::boolean,(p_consultant->>'notifications_enabled')::boolean,(p_consultant->>'whatsapp_authorized')::boolean) RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'NF_CONFLICT' USING ERRCODE='40001'; END;
  ELSE
    SELECT * INTO v_row FROM public.consultants WHERE id=v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NF_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF v_row.workspace_id<>v_workspace THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
    IF v_row.version<>p_expected_version THEN RAISE EXCEPTION 'NF_CONFLICT' USING ERRCODE='40001'; END IF;
    UPDATE public.consultants SET name=btrim(p_consultant->>'name'),phone=p_consultant->>'phone',email=btrim(p_consultant->>'email'),active=(p_consultant->>'active')::boolean,notifications_enabled=(p_consultant->>'notifications_enabled')::boolean,whatsapp_authorized=(p_consultant->>'whatsapp_authorized')::boolean,version=version+1,updated_at=clock_timestamp() WHERE id=v_id RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.save_invoice(p_invoice jsonb,p_expected_version integer) RETURNS public.invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_workspace uuid;v_id uuid;v_date date;v_due date;v_term integer;v_amount bigint;v_consultant uuid;v_client uuid;v_name text;v_row public.invoices;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
  PERFORM public.nf_validate_invoice_input(p_invoice);
  IF p_invoice IS NULL OR jsonb_typeof(p_invoice)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_invoice) k WHERE k NOT IN ('id','workspace_id','client_name','nf_number','billing_date','term_days','due_date','consultant','consultant_id','client_id','amount_cents','funding_source','bank_name'))
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['workspace_id','client_name','nf_number','billing_date','consultant','funding_source','bank_name']) k WHERE jsonb_typeof(p_invoice->k) IS DISTINCT FROM 'string')
    OR jsonb_typeof(p_invoice->'term_days') IS DISTINCT FROM 'number' OR (p_invoice->>'term_days') !~ '^[0-9]{1,4}$'
    OR jsonb_typeof(p_invoice->'amount_cents') IS DISTINCT FROM 'number' OR (p_invoice->>'amount_cents') !~ '^[0-9]{1,11}$'
    OR (p_invoice->>'billing_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR (p_invoice->>'due_date' IS NOT NULL AND (jsonb_typeof(p_invoice->'due_date')<>'string' OR (p_invoice->>'due_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
    OR (p_expected_version IS NOT NULL AND (p_expected_version NOT BETWEEN 1 AND 2147483646 OR NOT(p_invoice?'id')))
  THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023'; END IF;
  BEGIN
    v_workspace:=(p_invoice->>'workspace_id')::uuid;v_id:=coalesce((p_invoice->>'id')::uuid,gen_random_uuid());v_date:=(p_invoice->>'billing_date')::date;v_due:=(p_invoice->>'due_date')::date;v_term:=(p_invoice->>'term_days')::integer;v_amount:=(p_invoice->>'amount_cents')::bigint;v_consultant:=(p_invoice->>'consultant_id')::uuid;v_client:=(p_invoice->>'client_id')::uuid;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023'; END;
  PERFORM public.nf_require_account(v_workspace);
  -- Account lock serializes import batches and manual saves without a new unique NF index.
  PERFORM 1 FROM public.workspaces WHERE id=v_workspace FOR UPDATE;
  IF p_expected_version IS NULL AND EXISTS(SELECT 1 FROM public.invoices WHERE workspace_id=v_workspace AND public.nf_duplicate_key(client_name,nf_number)=public.nf_duplicate_key(p_invoice->>'client_name',p_invoice->>'nf_number')) THEN RAISE EXCEPTION 'NF_DUPLICATE' USING ERRCODE='23505'; END IF;
  v_name:=btrim(p_invoice->>'consultant');
  IF v_consultant IS NOT NULL THEN
    SELECT name INTO v_name FROM public.consultants WHERE workspace_id=v_workspace AND id=v_consultant;
    IF NOT FOUND THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
  END IF;
  IF v_client IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.clients WHERE workspace_id=v_workspace AND id=v_client) THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
  ELSE
    SELECT id INTO v_client FROM public.clients WHERE workspace_id=v_workspace AND public.nf_normalize(name)=public.nf_normalize(p_invoice->>'client_name');
    IF v_client IS NULL THEN INSERT INTO public.clients(workspace_id,name,consultant_id) VALUES(v_workspace,btrim(p_invoice->>'client_name'),v_consultant) RETURNING id INTO v_client; END IF;
  END IF;
  IF p_expected_version IS NULL THEN
    BEGIN INSERT INTO public.invoices(id,workspace_id,client_name,nf_number,billing_date,term_days,due_date,consultant,consultant_id,client_id,amount_cents,funding_source,bank_name)
      VALUES(v_id,v_workspace,btrim(p_invoice->>'client_name'),btrim(p_invoice->>'nf_number'),v_date,v_term,v_due,v_name,v_consultant,v_client,v_amount,p_invoice->>'funding_source',p_invoice->>'bank_name') RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'NF_CONFLICT' USING ERRCODE='40001'; END;
  ELSE
    SELECT * INTO v_row FROM public.invoices WHERE id=v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NF_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF v_row.workspace_id<>v_workspace THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
    IF v_row.version<>p_expected_version THEN RAISE EXCEPTION 'NF_CONFLICT' USING ERRCODE='40001'; END IF;
    UPDATE public.invoices SET client_name=btrim(p_invoice->>'client_name'),nf_number=btrim(p_invoice->>'nf_number'),billing_date=v_date,term_days=v_term,due_date=v_due,consultant=v_name,consultant_id=v_consultant,client_id=v_client,amount_cents=v_amount,funding_source=p_invoice->>'funding_source',bank_name=p_invoice->>'bank_name',version=version+1,updated_at=clock_timestamp() WHERE id=v_id RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.nf_audit_invoice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_row public.invoices;v_action text;v_details jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN v_row:=NEW;v_action:='created';v_details:=jsonb_build_object('after',to_jsonb(NEW));
  ELSIF TG_OP='DELETE' THEN v_row:=OLD;v_action:='deleted';v_details:=jsonb_build_object('before',to_jsonb(OLD));
  ELSE v_row:=NEW;v_action:=CASE WHEN OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL THEN 'cancelled' WHEN OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS NULL THEN 'restored' WHEN OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL THEN 'paid' WHEN OLD.paid_at IS NOT NULL AND NEW.paid_at IS NULL THEN 'reopened' ELSE 'updated' END;v_details:=jsonb_build_object('before',to_jsonb(OLD),'after',to_jsonb(NEW)); END IF;
  INSERT INTO public.invoice_events(invoice_id,workspace_id,client_name,nf_number,action,details,actor_id) VALUES(v_row.id,v_row.workspace_id,v_row.client_name,v_row.nf_number,v_action,v_details,auth.uid());
  RETURN coalesce(NEW,OLD);
END;
$$;
CREATE FUNCTION public.cancel_invoice(p_id uuid,p_cancelled boolean,p_expected_version integer) RETURNS public.invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_row public.invoices;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
  IF p_id IS NULL OR p_cancelled IS NULL OR p_expected_version IS NULL OR p_expected_version NOT BETWEEN 1 AND 2147483646 THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_row FROM public.invoices WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NF_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM public.nf_require_account(v_row.workspace_id);
  IF v_row.version<>p_expected_version THEN RAISE EXCEPTION 'NF_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p_cancelled AND v_row.paid_at IS NOT NULL THEN RAISE EXCEPTION 'NF_INELIGIBLE' USING ERRCODE='22023'; END IF;
  IF (v_row.cancelled_at IS NOT NULL)=p_cancelled THEN RETURN v_row; END IF;
  UPDATE public.invoices SET cancelled_at=CASE WHEN p_cancelled THEN clock_timestamp() ELSE NULL END,version=version+1,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE FUNCTION public.nf_validate_rules(p_rules jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF p_rules IS NULL OR jsonb_typeof(p_rules)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p_rules))<>6 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_rules) k WHERE k NOT IN ('before_days','on_due','after_days','repeat_days','hour','daily_summary'))
    OR jsonb_typeof(p_rules->'on_due') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_rules->'daily_summary') IS DISTINCT FROM 'boolean'
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['before_days','after_days']) k WHERE NOT (p_rules->k='null'::jsonb OR (jsonb_typeof(p_rules->k)='number' AND (p_rules->>k) ~ '^[0-9]{1,4}$' AND (p_rules->>k)::numeric BETWEEN 1 AND 3650)))
    OR jsonb_typeof(p_rules->'repeat_days') IS DISTINCT FROM 'number' OR (p_rules->>'repeat_days') !~ '^[0-9]{1,4}$' OR (p_rules->>'repeat_days')::numeric NOT BETWEEN 0 AND 3650
    OR jsonb_typeof(p_rules->'hour') IS DISTINCT FROM 'number' OR (p_rules->>'hour') !~ '^[0-9]{1,2}$' OR (p_rules->>'hour')::numeric NOT BETWEEN 0 AND 23
  THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023'; END IF;
  RETURN p_rules;
END;
$$;
ALTER TABLE public.billing_settings ADD CONSTRAINT billing_rules_valid CHECK(public.nf_validate_rules(rules)=rules);
CREATE FUNCTION public.get_billing_settings(p_workspace_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_rules jsonb;
BEGIN PERFORM public.nf_require_account(p_workspace_id);SELECT rules INTO v_rules FROM public.billing_settings WHERE workspace_id=p_workspace_id;RETURN coalesce(v_rules,'{"before_days":1,"on_due":true,"after_days":1,"repeat_days":3,"hour":9,"daily_summary":true}'::jsonb);END;
$$;
CREATE FUNCTION public.save_billing_settings(p_workspace_id uuid,p_rules jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.nf_require_account(p_workspace_id);PERFORM public.nf_validate_rules(p_rules);
  INSERT INTO public.billing_settings(workspace_id,rules) VALUES(p_workspace_id,p_rules) ON CONFLICT(workspace_id) DO UPDATE SET rules=excluded.rules,updated_at=clock_timestamp();RETURN p_rules;
END;
$$;

CREATE FUNCTION public.record_notification(p_notification jsonb) RETURNS public.notifications
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_workspace uuid;v_id uuid;v_invoice uuid;v_consultant uuid;v_note public.invoices;v_contact public.consultants;v_row public.notifications;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
  IF p_notification IS NULL OR jsonb_typeof(p_notification)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_notification) k WHERE k NOT IN ('id','workspace_id','invoice_id','consultant_id','channel','status','message','phone','error'))
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['workspace_id','invoice_id','consultant_id','channel','status','message','phone']) k WHERE jsonb_typeof(p_notification->k) IS DISTINCT FROM 'string')
    OR p_notification->>'channel'<>'whatsapp_manual' OR p_notification->>'status' NOT IN ('prepared','failed')
    OR regexp_replace(p_notification->>'message',E'[\n\r]','','g') ~ '[[:cntrl:]]'
  THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023'; END IF;
  BEGIN v_workspace:=(p_notification->>'workspace_id')::uuid;v_id:=coalesce((p_notification->>'id')::uuid,gen_random_uuid());v_invoice:=(p_notification->>'invoice_id')::uuid;v_consultant:=(p_notification->>'consultant_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023';END;
  PERFORM public.nf_require_account(v_workspace);
  SELECT * INTO v_row FROM public.notifications WHERE id=v_id;
  IF FOUND THEN
    IF v_row.workspace_id<>v_workspace THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
    IF v_row.invoice_id<>v_invoice OR v_row.consultant_id<>v_consultant OR v_row.message<>p_notification->>'message' OR v_row.phone<>p_notification->>'phone' OR (v_row.error IS DISTINCT FROM p_notification->>'error') THEN RAISE EXCEPTION 'NF_CONFLICT' USING ERRCODE='40001'; END IF;
    RETURN v_row;
  END IF;
  SELECT * INTO v_note FROM public.invoices WHERE id=v_invoice AND workspace_id=v_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
  IF v_note.paid_at IS NOT NULL OR v_note.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'NF_INELIGIBLE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_contact FROM public.consultants WHERE id=v_consultant AND workspace_id=v_workspace;
  IF NOT FOUND OR (v_note.consultant_id IS NOT NULL AND v_note.consultant_id<>v_consultant)
    OR (v_note.consultant_id IS NULL AND public.nf_normalize(v_note.consultant)<>public.nf_normalize(v_contact.name)) THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
  IF NOT v_contact.active OR NOT v_contact.notifications_enabled OR v_contact.phone='' THEN RAISE EXCEPTION 'NF_INELIGIBLE' USING ERRCODE='22023'; END IF;
  IF v_contact.phone<>p_notification->>'phone' THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023'; END IF;
  INSERT INTO public.notifications(id,workspace_id,invoice_id,consultant_id,channel,status,message,phone,error) VALUES(v_id,v_workspace,v_invoice,v_consultant,'whatsapp_manual',p_notification->>'status',p_notification->>'message',v_contact.phone,p_notification->>'error') RETURNING * INTO v_row;
  RETURN v_row;
EXCEPTION WHEN check_violation OR not_null_violation THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023';
END;
$$;
CREATE FUNCTION public.confirm_notification(p_id uuid) RETURNS public.notifications
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_row public.notifications;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
  IF p_id IS NULL THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_row FROM public.notifications WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NF_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM public.nf_require_account(v_row.workspace_id);
  IF v_row.status='confirmed_by_user' THEN RETURN v_row; END IF;
  IF v_row.status<>'prepared' THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023'; END IF;
  UPDATE public.notifications SET status='confirmed_by_user',confirmed_at=clock_timestamp() WHERE id=p_id RETURNING * INTO v_row;RETURN v_row;
END;
$$;

CREATE FUNCTION public.import_invoices(p_workspace_id uuid,p_batch jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_id uuid;v_hash text;v_old public.imports;v_item jsonb;v_invoice public.invoices;v_contact public.consultants;v_consultant_id uuid;v_imported jsonb:='[]';v_duplicates jsonb:='[]';v_consultants jsonb:='[]';v_result jsonb;v_meta jsonb;v_index integer:=0;v_duplicate integer;v_errors integer;v_ignored integer;v_total integer;
BEGIN
  PERFORM public.nf_require_account(p_workspace_id);
  IF p_batch IS NULL OR jsonb_typeof(p_batch)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_batch) k WHERE k NOT IN ('id','file_name','rows','total_count','error_count','duplicate_count','ignored_count'))
    OR jsonb_typeof(p_batch->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(p_batch->'file_name') IS DISTINCT FROM 'string' OR char_length(btrim(p_batch->>'file_name')) NOT BETWEEN 1 AND 255 OR p_batch->>'file_name' ~ '[[:cntrl:]]'
    OR jsonb_typeof(p_batch->'rows') IS DISTINCT FROM 'array'
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['total_count','error_count','duplicate_count','ignored_count']) k WHERE jsonb_typeof(p_batch->k) IS DISTINCT FROM 'number' OR (p_batch->>k) !~ '^[0-9]{1,4}$')
  THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023';END IF;
  BEGIN v_id:=(p_batch->>'id')::uuid;v_total:=(p_batch->>'total_count')::integer;v_errors:=(p_batch->>'error_count')::integer;v_duplicate:=(p_batch->>'duplicate_count')::integer;v_ignored:=(p_batch->>'ignored_count')::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023';END;
  IF v_total>5000 OR v_total<>jsonb_array_length(p_batch->'rows')+v_errors+v_duplicate+v_ignored THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023';END IF;
  PERFORM 1 FROM public.workspaces WHERE id=p_workspace_id FOR UPDATE;
  v_hash:=encode(sha256(convert_to(p_batch::text,'UTF8')),'hex');
  SELECT * INTO v_old FROM public.imports WHERE id=v_id;
  IF FOUND THEN
    IF v_old.workspace_id<>p_workspace_id THEN RAISE EXCEPTION 'NF_ACCESS' USING ERRCODE='42501'; END IF;
    IF v_old.request_hash<>v_hash THEN RAISE EXCEPTION 'NF_CONFLICT' USING ERRCODE='40001'; END IF;
    RETURN v_old.result;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_batch->'rows') LOOP
    IF jsonb_typeof(v_item)<>'object' OR (v_item?'workspace_id' AND v_item->>'workspace_id'<>p_workspace_id::text) THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023';END IF;
    IF v_item?'consultant_phone' AND (jsonb_typeof(v_item->'consultant_phone') IS DISTINCT FROM 'string' OR NOT(v_item->>'consultant_phone'='' OR v_item->>'consultant_phone' ~ '^\+[1-9][0-9]{7,14}$')) THEN RAISE EXCEPTION 'NF_VALIDATION' USING ERRCODE='22023'; END IF;
    PERFORM public.nf_validate_invoice_input((v_item-'consultant_phone')||jsonb_build_object('workspace_id',p_workspace_id));
    IF EXISTS(SELECT 1 FROM public.invoices WHERE workspace_id=p_workspace_id AND public.nf_duplicate_key(client_name,nf_number)=public.nf_duplicate_key(v_item->>'client_name',v_item->>'nf_number')) THEN
      v_duplicate:=v_duplicate+1;v_duplicates:=v_duplicates||jsonb_build_array(jsonb_build_object('index',v_index,'reason','NF_DUPLICATE'));
    ELSE
      v_consultant_id:=NULL;
      IF coalesce(v_item->>'consultant','')<>'' AND NOT(v_item?'consultant_id' AND v_item->>'consultant_id' IS NOT NULL) THEN
        SELECT * INTO v_contact FROM public.consultants WHERE workspace_id=p_workspace_id AND public.nf_normalize(name)=public.nf_normalize(v_item->>'consultant');
        IF NOT FOUND THEN
          v_contact:=public.save_consultant(jsonb_build_object('workspace_id',p_workspace_id,'name',v_item->>'consultant','phone',coalesce(v_item->>'consultant_phone',''),'email','','active',true,'notifications_enabled',true,'whatsapp_authorized',false),NULL);
          v_consultants:=v_consultants||jsonb_build_array(to_jsonb(v_contact));
        END IF;
        v_consultant_id:=v_contact.id;
      END IF;
      v_item:=(v_item-'consultant_phone')||jsonb_build_object('workspace_id',p_workspace_id);
      IF v_consultant_id IS NOT NULL THEN v_item:=v_item||jsonb_build_object('consultant_id',v_consultant_id);END IF;
      v_invoice:=public.save_invoice(v_item,NULL);v_imported:=v_imported||jsonb_build_array(to_jsonb(v_invoice));
    END IF;
    v_index:=v_index+1;
  END LOOP;
  v_meta:=jsonb_build_object('id',v_id,'workspace_id',p_workspace_id,'file_name',btrim(p_batch->>'file_name'),'total_count',v_total,'imported_count',jsonb_array_length(v_imported),'duplicate_count',v_duplicate,'error_count',v_errors,'ignored_count',v_ignored,'created_at',now(),'status',CASE WHEN v_errors=0 THEN 'completed' WHEN jsonb_array_length(v_imported)=0 THEN 'failed' ELSE 'partial' END);
  v_result:=jsonb_build_object('import',v_meta,'imported',v_imported,'duplicates',v_duplicates,'consultants',v_consultants);
  INSERT INTO public.imports(id,workspace_id,file_name,total_count,imported_count,duplicate_count,error_count,ignored_count,status,request_hash,result)
    VALUES(v_id,p_workspace_id,v_meta->>'file_name',v_total,jsonb_array_length(v_imported),v_duplicate,v_errors,v_ignored,v_meta->>'status',v_hash,v_result);
  RETURN v_result;
END;
$$;

DO $$ DECLARE v_table text;BEGIN
  FOREACH v_table IN ARRAY ARRAY['consultants','clients','billing_settings','imports','notifications','entity_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_table);
    EXECUTE format('CREATE POLICY own_account_read ON public.%I FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.workspaces w WHERE w.id=workspace_id AND w.owner_id=(SELECT auth.uid())))',v_table);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',v_table);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated',v_table);
  END LOOP;
END;$$;
REVOKE ALL ON SEQUENCE public.entity_events_id_seq FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.nf_normalize(text),public.nf_duplicate_key(text,text),public.nf_require_account(uuid),public.nf_validate_invoice_input(jsonb),public.nf_audit_entity(),public.nf_validate_rules(jsonb),public.save_consultant(jsonb,integer),public.get_billing_settings(uuid),public.save_billing_settings(uuid,jsonb),public.cancel_invoice(uuid,boolean,integer),public.record_notification(jsonb),public.confirm_notification(uuid),public.import_invoices(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_consultant(jsonb,integer),public.get_billing_settings(uuid),public.save_billing_settings(uuid,jsonb),public.cancel_invoice(uuid,boolean,integer),public.record_notification(jsonb),public.confirm_notification(uuid),public.import_invoices(uuid,jsonb) TO authenticated;
COMMIT;
