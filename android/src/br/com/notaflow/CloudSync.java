package br.com.notaflow;

import android.content.Context;
import org.json.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Read-only background refresh. UI owns every invoice mutation. */
final class CloudSync {
 private static final class Response{int status;String body;Response(int s,String b){status=s;body=b;}}
 private static Response request(String method,String url,String key,String token,String body)throws Exception{
  HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();c.setConnectTimeout(10000);c.setReadTimeout(15000);c.setInstanceFollowRedirects(false);c.setRequestMethod(method);c.setRequestProperty("apikey",key);c.setRequestProperty("Content-Type","application/json");if(token!=null)c.setRequestProperty("Authorization","Bearer "+token);
  try{if(body!=null){c.setDoOutput(true);try(OutputStream out=c.getOutputStream()){out.write(body.getBytes(StandardCharsets.UTF_8));}}int status=c.getResponseCode();InputStream source=status<400?c.getInputStream():c.getErrorStream();ByteArrayOutputStream bytes=new ByteArrayOutputStream();if(source!=null)try(InputStream in=source){byte[] buf=new byte[8192];int n;while((n=in.read(buf))!=-1){bytes.write(buf,0,n);if(bytes.size()>12000000)throw new IOException("Resposta excedeu limite");}}return new Response(status,new String(bytes.toByteArray(),StandardCharsets.UTF_8));}finally{c.disconnect();}
 }
 private static JSONArray rows(String url,String table,String workspace,String key,String token)throws Exception{
  JSONArray rows=new JSONArray();
  for(int offset=0;offset<=50000;offset+=1000){int limit=offset==50000?1:1000;Response r=request("GET",url+"/rest/v1/"+table+"?workspace_id=eq."+workspace+"&select=*&order=id.asc&limit="+limit+"&offset="+offset,key,token,null);if(r.status!=200)return null;JSONArray page=new JSONArray(r.body);if(offset==50000&&page.length()>0)throw new IOException("Muitos registros para o cache local");for(int n=0;n<page.length();n++)rows.put(page.get(n));if(page.length()<limit)break;}
  return rows;
 }
 static void sync(Context c)throws Exception{
  JSONObject state=new JSONObject(SecureStore.get(c,"state","{}"));if(!"cloud".equals(state.optString("mode"))||MainActivity.active)return;JSONObject cloud=state.optJSONObject("cloud");if(cloud==null)return;
  String url=cloud.optString("url").replaceAll("/+$",""),key=cloud.optString("key"),workspace=cloud.optString("workspaceId");JSONObject session=cloud.optJSONObject("session");
  if(!url.matches("https://[a-z0-9-]+\\.supabase\\.(co|in)")||!workspace.matches("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}")||session==null||key.isEmpty())return;
  String expectedRefresh=session.optString("refresh_token"),token=session.optString("access_token");if(token.isEmpty())return;
  if(session.optLong("expires_at",0)<System.currentTimeMillis()/1000+90){
   if(expectedRefresh.isEmpty())return;
   Response refreshed=request("POST",url+"/auth/v1/token?grant_type=refresh_token",key,null,new JSONObject().put("refresh_token",expectedRefresh).toString());if(refreshed.status!=200)return;
   JSONObject updatedSession=new JSONObject(refreshed.body);if(updatedSession.optString("access_token").isEmpty()||updatedSession.optString("refresh_token").isEmpty())return;
   if(!updatedSession.has("expires_at"))updatedSession.put("expires_at",System.currentTimeMillis()/1000+updatedSession.optInt("expires_in",3600));
   synchronized(SecureStore.LOCK){JSONObject current=new JSONObject(SecureStore.get(c,"state","{}"));if(MainActivity.active||!same(current,url,key,workspace,expectedRefresh,token))return;current.getJSONObject("cloud").put("session",updatedSession);SecureStore.put(c,"state",current.toString());}
   session=updatedSession;expectedRefresh=session.optString("refresh_token");token=session.getString("access_token");
  }
  JSONArray invoices=rows(url,"invoices",workspace,key,token);if(invoices==null)return;
  JSONArray consultants=rows(url,"consultants",workspace,key,token);if(consultants==null)return;
  Response settingsResponse=request("GET",url+"/rest/v1/billing_settings?select=rules&workspace_id=eq."+workspace,key,token,null);if(settingsResponse.status!=200)return;
  JSONArray settings=new JSONArray(settingsResponse.body);JSONObject rules=settings.length()>0?settings.getJSONObject(0).optJSONObject("rules"):null;ReminderJob.Policy policy=new ReminderJob.Policy(rules);
  synchronized(SecureStore.LOCK){
   JSONObject current=new JSONObject(SecureStore.get(c,"state","{}"));if(MainActivity.active||!same(current,url,key,workspace,expectedRefresh,token))return;
   String scope=ReminderJob.scope(current);JSONArray old=scope.equals(SecureStore.get(c,"invoices_scope",""))?new JSONArray(SecureStore.get(c,"invoices","[]")):new JSONArray();
   Map<String,JSONObject> byId=new HashMap<>();for(int n=0;n<old.length();n++){JSONObject row=old.optJSONObject(n);if(row!=null)byId.put(row.optString("id"),row);}
   // Persist the context first so a switched account can never evaluate old rows.
   ReminderJob.cacheContext(c,new JSONObject().put("scope",scope).put("consultants",consultants).put("billingRules",policy.json()));
   SecureStore.put(c,"invoices",invoices.toString());SecureStore.put(c,"invoices_scope",scope);
   for(int n=0;n<invoices.length();n++){JSONObject row=invoices.getJSONObject(n),previous=byId.get(row.optString("id"));if(previous!=null&&(previous.isNull("paid_at")||previous.optString("paid_at").isEmpty())&&!row.isNull("paid_at")&&!row.optString("paid_at").isEmpty())ReminderJob.payment(c,row.optString("client_name"),row.optString("nf_number"));}
  }
 }
 private static boolean same(JSONObject state,String url,String key,String workspace,String refresh,String token){
  JSONObject cloud=state.optJSONObject("cloud"),session=cloud==null?null:cloud.optJSONObject("session");
  return cloud!=null&&session!=null&&"cloud".equals(state.optString("mode"))&&url.equals(cloud.optString("url").replaceAll("/+$",""))&&key.equals(cloud.optString("key"))&&workspace.equals(cloud.optString("workspaceId"))&&refresh.equals(session.optString("refresh_token"))&&token.equals(session.optString("access_token"));
 }
}
