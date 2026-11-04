/* Cloud is intentionally unconfigured. Enter a real project's HTTPS URL and
 * publishable/anon PUBLIC key in Settings after applying backend/schema.sql.
 * Never put a service_role or sb_secret key in this file or in the Android app. */
(function (root) {
  'use strict';
  root.NF_CONFIG = Object.freeze({supabaseUrl:'',supabaseKey:''});
})(typeof globalThis !== 'undefined' ? globalThis : this);
