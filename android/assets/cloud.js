(function (root) {
  'use strict';

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const TOKEN = /^[A-Za-z0-9._~-]{1,16384}$/;
  function fail(message, code, status) {
    const error = new Error(message);
    error.code = code || 'VALIDATION';
    if (status) error.status = status;
    return error;
  }
  function uuid(value) {
    if (typeof value !== 'string' || !UUID.test(value)) throw fail('Identificador inválido. Atualize os dados.');
    return value;
  }
  function text(value, name, max) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) {
      throw fail(name + ' inválido. Use de 1 a ' + max + ' caracteres.');
    }
    return value.trim();
  }
  function version(value, nullable) {
    if (nullable && value === null) return null;
    if (!Number.isInteger(value) || value < 1 || value > 2147483646) throw fail('Versão inválida. Atualize a lista antes de salvar.');
    return value;
  }
  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail('Data de faturamento inválida.');
    const [y, m, d] = value.split('-').map(Number);
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]) {
      throw fail('Data de faturamento inválida.');
    }
    return value;
  }
  function optionalText(value,name,max) {
    if(value === undefined || value === null || value === '') return '';
    return text(value,name,max);
  }
  function phone(value) {
    value=optionalText(value,'Telefone',20);
    if(value && !/^\+[1-9]\d{7,14}$/.test(value)) throw fail('Informe o telefone com código do país e DDD.');
    return value;
  }
  function billingRules(input) {
    if(!input || typeof input!=='object' || Array.isArray(input)) throw fail('Regras de cobrança inválidas.');
    const out={};
    for(const key of ['before_days','after_days']) {
      const value=input[key];if(value!==null && (!Number.isInteger(value)||value<1||value>3650)) throw fail('Intervalo de cobrança inválido.');out[key]=value;
    }
    if(typeof input.on_due!=='boolean'||typeof input.daily_summary!=='boolean'||!Number.isInteger(input.repeat_days)||input.repeat_days<0||input.repeat_days>3650||!Number.isInteger(input.hour)||input.hour<0||input.hour>23) throw fail('Regras de cobrança inválidas.');
    return {...out,on_due:input.on_due,repeat_days:input.repeat_days,hour:input.hour,daily_summary:input.daily_summary};
  }
  function publicKey(key) {
    if (typeof key !== 'string' || /\s/.test(key)) return false;
    if (/^sb_publishable_[A-Za-z0-9_-]{20,256}$/.test(key)) return true;
    const parts = key.split('.');
    if (parts.length !== 3 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) return false;
    try {
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const decoded = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('utf8');
      return JSON.parse(decoded).role === 'anon';
    } catch (_) { return false; }
  }
  function normalizedSession(value) {
    if (!value || !TOKEN.test(value.access_token || '') || !TOKEN.test(value.refresh_token || '') || !value.user || !UUID.test(value.user.id || '')) return null;
    const expires = Number(value.expires_at) || (Number(value.expires_in) > 0 ? Math.floor(Date.now() / 1000) + Number(value.expires_in) : 0);
    return {access_token:value.access_token,refresh_token:value.refresh_token,expires_at:expires,user:{id:value.user.id,email:typeof value.user.email === 'string' ? value.user.email : ''}};
  }

  class NFCloud {
    constructor({url, key, session = null, onSession = () => {}, fetch: fetchFn, timeoutMs = 15000} = {}) {
      let parsed;
      try { parsed = new URL(url); } catch (_) { throw fail('Configure uma URL HTTPS válida do Supabase.', 'CONFIG'); }
      if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname) || parsed.username || parsed.password || parsed.port || (parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
        throw fail('Configure a URL HTTPS do projeto Supabase, sem caminho ou parâmetros.', 'CONFIG');
      }
      if (!publicKey(key)) throw fail('Use somente a chave pública publishable ou anon do Supabase.', 'CONFIG');
      this.url = parsed.origin;
      this.key = key;
      this.session = normalizedSession(session);
      this.onSession = typeof onSession === 'function' ? onSession : () => {};
      this.fetch = fetchFn || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
      if (!this.fetch) throw fail('Este dispositivo não oferece conexão compatível.', 'CONFIG');
      this.timeoutMs = Math.max(1, Math.min(Number(timeoutMs) || 15000, 60000));
      this.refreshing = null;
      this.sessionGeneration = 0;
    }

    _session(value) {
      this.session = normalizedSession(value);
      this.sessionGeneration++;
      this.onSession(this.session);
      return this.session;
    }

    async _fetch(path, method, body, token) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const headers = {apikey:this.key,Accept:'application/json'};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = 'Bearer ' + token;
      try {
        const response = await this.fetch(this.url + path, {method,headers,body:body === undefined ? undefined : JSON.stringify(body),signal:controller.signal,redirect:'error',referrerPolicy:'no-referrer',credentials:'omit',cache:'no-store'});
        let data = null;
        if (response.status !== 204) {
          const raw = await response.text();
          if (raw) {
            try { data = JSON.parse(raw); } catch (_) { throw fail('Resposta inválida do serviço. Atualize a lista antes de tentar novamente.', 'RESPONSE', response.status); }
          }
        }
        return {status:response.status,ok:response.ok,data};
      } catch (error) {
        if (error && error.code === 'RESPONSE') throw error;
        throw fail('Falha de conexão. Atualize a lista para conferir o resultado antes de tentar novamente.', 'NETWORK');
      } finally { clearTimeout(timer); }
    }

    _error(result) {
      const data = result.data || {};
      if(data.message==='NF_DUPLICATE') return fail('Esta NF já existe para o cliente. Atualize a lista.', 'DUPLICATE',result.status);
      if (data.message === 'NF_CONFLICT' || data.code === '40001' || result.status === 409) return fail('Outra pessoa alterou esta nota. Atualize a lista e tente novamente.', 'CONFLICT', result.status);
      if (result.status === 401) return fail('Sua sessão expirou. Entre novamente.', 'AUTH', 401);
      if (result.status === 403 || data.message === 'NF_ACCESS') return fail('Você não tem acesso a esta conta ou nota.', 'ACCESS', result.status);
      if (data.message === 'NF_NOT_FOUND') return fail('Esta nota foi removida. Atualize a lista.', 'NOT_FOUND', result.status);
      if (data.message === 'NF_VALIDATION' || data.code === '22023' || data.code === '23514') return fail('Revise os dados informados antes de salvar.', 'VALIDATION', result.status);
      if (result.status === 429) return fail('Muitas tentativas. Aguarde alguns minutos e tente novamente.', 'RATE_LIMIT', result.status);
      if (data.error_code === 'email_not_confirmed' || data.code === 'email_not_confirmed') return fail('Confirme seu e-mail antes de entrar.', 'AUTH', result.status);
      if (result.status === 400 && data.error_code === 'invalid_credentials') return fail('E-mail ou senha incorretos.', 'AUTH', result.status);
      if (result.status >= 500) return fail('Serviço indisponível. Atualize a lista antes de tentar novamente.', 'SERVER', result.status);
      return fail('Não foi possível concluir. Confira os dados, o e-mail e a senha; tente novamente.', 'REQUEST', result.status);
    }

    async _refresh() {
      if (this.refreshing) return this.refreshing;
      if (!this.session) throw fail('Entre na sua conta para sincronizar.', 'AUTH');
      const previous = this.session;
      const generation = this.sessionGeneration;
      this.refreshing = (async () => {
        const result = await this._fetch('/auth/v1/token?grant_type=refresh_token', 'POST', {refresh_token:previous.refresh_token});
        if (generation !== this.sessionGeneration) throw fail('A sessão mudou. Entre novamente ou atualize a lista.', 'AUTH');
        if (!result.ok) {
          if (result.status === 400 || result.status === 401 || result.status === 403) {
            this._session(null);
            throw fail('Sua sessão expirou. Entre novamente.', 'AUTH');
          }
          throw this._error(result);
        }
        if (!normalizedSession(result.data)) {
          this._session(null);
          throw fail('Sua sessão expirou. Entre novamente.', 'AUTH');
        }
        return this._session(result.data);
      })();
      try { return await this.refreshing; } finally { this.refreshing = null; }
    }

    async _protected(path, method = 'GET', body) {
      if (!this.session) throw fail('Entre na sua conta para sincronizar.', 'AUTH');
      if (this.session.expires_at && this.session.expires_at <= Math.floor(Date.now() / 1000) + 30) await this._refresh();
      const token = this.session.access_token;
      let result = await this._fetch(path, method, body, token);
      if (result.status === 401) {
        if (this.session && this.session.access_token === token) await this._refresh();
        if (method !== 'GET') throw fail('Sessão renovada. Atualize a lista e tente novamente.', 'AUTH_RETRY', 401);
        if (!this.session) throw fail('Entre novamente na sua conta.', 'AUTH');
        result = await this._fetch(path, method, body, this.session.access_token);
      }
      if (!result.ok) throw this._error(result);
      return result.data;
    }

    async _rows(path) {
      const rows = [];
      for (let offset = 0; offset < 100000; offset += 500) {
        const page = await this._protected(path + '&limit=500&offset=' + offset);
        if (!Array.isArray(page)) throw fail('Resposta inválida do serviço. Atualize os dados.', 'RESPONSE');
        rows.push(...page);
        if (page.length < 500) return rows;
      }
      throw fail('A conta tem muitos registros para esta versão. Exporte e organize o histórico.', 'LIMIT');
    }

    async signIn(email, password) {
      email = text(email, 'E-mail', 254);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || !password || password.length > 1024) throw fail('Informe seu e-mail e sua senha.');
      const result = await this._fetch('/auth/v1/token?grant_type=password', 'POST', {email,password});
      if (!result.ok) throw this._error(result);
      if (!normalizedSession(result.data)) throw fail('Resposta de autenticação inválida. Entre novamente.', 'AUTH');
      return this._session(result.data);
    }

    async signUp(email, password) {
      email = text(email, 'E-mail', 254);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 8 || password.length > 1024) throw fail('Informe um e-mail válido e uma senha com pelo menos 8 caracteres.');
      const result = await this._fetch('/auth/v1/signup', 'POST', {email,password});
      if (!result.ok) throw this._error(result);
      const session = normalizedSession(result.data);
      if (session) this._session(session);
      const user = result.data && (result.data.user || result.data);
      return {user:user ? {id:user.id,email:user.email} : null,session,confirmationRequired:!session};
    }

    async signOut() {
      const session = this.session;
      this._session(null);
      if (session) {
        try { await this._fetch('/auth/v1/logout?scope=local', 'POST', undefined, session.access_token); } catch (_) { /* Local encrypted credentials have already been removed. */ }
      }
    }

    async ensureAccount() {
      const account = await this._protected('/rest/v1/rpc/ensure_account', 'POST', {});
      if (!account || !UUID.test(account.id || '') || typeof account.name !== 'string' || !account.name.trim()) throw fail('Resposta inválida da conta. Atualize os dados.', 'RESPONSE');
      return {id:account.id,name:account.name};
    }
    async listInvoices(workspaceId) {
      return this._rows('/rest/v1/invoices?select=*&workspace_id=eq.' + uuid(workspaceId) + '&order=updated_at.desc,id.asc');
    }
    async listEvents(workspaceId) {
      return this._rows('/rest/v1/invoice_events?select=*&workspace_id=eq.' + uuid(workspaceId) + '&order=created_at.desc,id.desc');
    }
    _invoiceFields(invoice, allowUnspecified=false, workspaceId=null, importing=false) {
      if (!invoice || typeof invoice !== 'object') throw fail('Dados da nota inválidos.');
      const fields = {};
      if (invoice.id !== undefined && invoice.id !== null) fields.id = uuid(invoice.id);
      fields.workspace_id = uuid(workspaceId || invoice.workspace_id);
      fields.client_name = text(invoice.client_name, 'Nome do cliente', 160);
      fields.nf_number = text(invoice.nf_number, 'Número da NF', 80);
      fields.billing_date = date(invoice.billing_date);
      if (!Number.isInteger(invoice.term_days) || invoice.term_days < 0 || invoice.term_days > 3650) throw fail('Prazo inválido. Use de 0 a 3650 dias.');
      fields.term_days = invoice.term_days;
      fields.consultant = optionalText(invoice.consultant,'Nome do consultor',160);
      for(const key of ['consultant_id','client_id']) if(invoice[key]!==undefined) fields[key]=invoice[key]===null?null:uuid(invoice[key]);
      if(invoice.due_date!==undefined) {
        fields.due_date=invoice.due_date===null?null:date(invoice.due_date);
        if(fields.due_date && (Date.parse(fields.due_date+'T00:00:00Z')-Date.parse(fields.billing_date+'T00:00:00Z'))/86400000!==fields.term_days) throw fail('O prazo contradiz a data de vencimento.');
      }
      if (!Number.isSafeInteger(invoice.amount_cents) || invoice.amount_cents < 1 || invoice.amount_cents > 99999999999) throw fail('Informe um valor válido para a nota.');
      fields.amount_cents = invoice.amount_cents;
      if (!['bank','own'].includes(invoice.funding_source) && !(allowUnspecified && invoice.funding_source==='unspecified')) throw fail('Selecione banco ou recursos próprios.');
      fields.funding_source = invoice.funding_source;
      fields.bank_name = invoice.funding_source === 'bank' ? text(invoice.bank_name, 'Nome do banco', 80) : '';
      if(importing && invoice.consultant_phone!==undefined) fields.consultant_phone=phone(invoice.consultant_phone);
      return fields;
    }
    async saveInvoice(invoice, expectedVersion) {
      const fields=this._invoiceFields(invoice,invoice && invoice.funding_source==='unspecified');
      version(expectedVersion, true);
      if (expectedVersion !== null && !fields.id) throw fail('Identificador da nota ausente. Atualize a lista.');
      return this._protected('/rest/v1/rpc/save_invoice', 'POST', {p_invoice:fields,p_expected_version:expectedVersion});
    }
    async setPaid(id, paid, expectedVersion) {
      if (typeof paid !== 'boolean') throw fail('Confirmação de pagamento inválida.');
      return this._protected('/rest/v1/rpc/set_invoice_paid', 'POST', {p_id:uuid(id),p_paid:paid,p_expected_version:version(expectedVersion)});
    }
    async deleteInvoice(id, expectedVersion) {
      return this._protected('/rest/v1/rpc/delete_invoice', 'POST', {p_id:uuid(id),p_expected_version:version(expectedVersion)});
    }
    async listConsultants(accountId) {return this._rows('/rest/v1/consultants?select=*&workspace_id=eq.'+uuid(accountId)+'&order=name.asc,id.asc');}
    async listImports(accountId) {return this._rows('/rest/v1/imports?select=id,workspace_id,file_name,total_count,imported_count,duplicate_count,error_count,ignored_count,status,created_at&workspace_id=eq.'+uuid(accountId)+'&order=created_at.desc,id.desc');}
    async listNotifications(accountId) {return this._rows('/rest/v1/notifications?select=*&workspace_id=eq.'+uuid(accountId)+'&order=created_at.desc,id.desc');}
    async saveConsultant(record,expectedVersion) {
      if(!record||typeof record!=='object') throw fail('Dados do consultor inválidos.');
      const fields={workspace_id:uuid(record.workspace_id),name:text(record.name,'Nome do consultor',160),phone:phone(record.phone),email:optionalText(record.email,'E-mail',254)};
      if(fields.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) throw fail('E-mail inválido.');
      for(const key of ['active','notifications_enabled','whatsapp_authorized']) {if(typeof record[key]!=='boolean') throw fail('Preferências do consultor inválidas.');fields[key]=record[key];}
      if(record.id!==undefined&&record.id!==null) fields.id=uuid(record.id);
      version(expectedVersion,true);if(expectedVersion!==null&&!fields.id) throw fail('Identificador do consultor ausente.');
      return this._protected('/rest/v1/rpc/save_consultant','POST',{p_consultant:fields,p_expected_version:expectedVersion});
    }
    async getBillingSettings(accountId) {return this._protected('/rest/v1/rpc/get_billing_settings','POST',{p_workspace_id:uuid(accountId)});}
    async saveBillingSettings(accountId,rules) {return this._protected('/rest/v1/rpc/save_billing_settings','POST',{p_workspace_id:uuid(accountId),p_rules:billingRules(rules)});}
    async cancelInvoice(id,cancelled,expectedVersion) {
      if(typeof cancelled!=='boolean') throw fail('Confirmação de cancelamento inválida.');
      return this._protected('/rest/v1/rpc/cancel_invoice','POST',{p_id:uuid(id),p_cancelled:cancelled,p_expected_version:version(expectedVersion)});
    }
    async recordNotification(record) {
      if(!record||typeof record!=='object'||record.channel!=='whatsapp_manual'||!['prepared','failed'].includes(record.status)) throw fail('Notificação inválida.');
      if(typeof record.message!=='string'||!record.message.trim()||record.message.length>6000||/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(record.message)) throw fail('Mensagem inválida.');
      const fields={workspace_id:uuid(record.workspace_id),invoice_id:uuid(record.invoice_id),consultant_id:uuid(record.consultant_id),channel:record.channel,status:record.status,message:record.message,phone:phone(record.phone),error:record.error?text(record.error,'Erro',500):null};
      if(record.id!==undefined&&record.id!==null) fields.id=uuid(record.id);
      return this._protected('/rest/v1/rpc/record_notification','POST',{p_notification:fields});
    }
    async confirmNotification(id) {return this._protected('/rest/v1/rpc/confirm_notification','POST',{p_id:uuid(id)});}
    async importInvoices(accountId,batch) {
      uuid(accountId);
      if(!batch||!Array.isArray(batch.rows)||batch.rows.length>5000) throw fail('Lote de importação inválido.');
      const out={id:uuid(batch.id),file_name:text(batch.file_name,'Nome do arquivo',255),rows:batch.rows.map(row=>this._invoiceFields(row,true,accountId,true))};
      for(const key of ['total_count','error_count','duplicate_count','ignored_count']) {if(!Number.isInteger(batch[key])||batch[key]<0||batch[key]>5000) throw fail('Contagem de importação inválida.');out[key]=batch[key];}
      if(out.total_count!==out.rows.length+out.error_count+out.duplicate_count+out.ignored_count) throw fail('A contagem do lote não confere.');
      return this._protected('/rest/v1/rpc/import_invoices','POST',{p_workspace_id:accountId,p_batch:out});
    }
  }
  root.NFCloud = NFCloud;
  if (typeof module !== 'undefined' && module.exports) module.exports = NFCloud;
})(typeof globalThis !== 'undefined' ? globalThis : this);
