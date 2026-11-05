package br.com.notaflow;

import android.Manifest;
import android.app.*;
import android.app.job.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.Build;
import org.json.*;
import java.time.*;
import java.text.Normalizer;
import java.util.*;

/** Local Android alerts only. Showing one never means WhatsApp was sent. */
public final class ReminderJob extends JobService {
 private static final int MAX_LOG=10000,MAX_LEDGER=100000;
 private volatile boolean stopped;
 static final class Policy {
  final Integer before,after;final boolean onDue,summary;final int repeat,hour;final String key;
  Policy(JSONObject rules)throws JSONException{JSONObject r=rules==null?new JSONObject():rules;before=nullable(r,"before_days",1);after=nullable(r,"after_days",1);onDue=r.optBoolean("on_due",true);summary=r.optBoolean("daily_summary",true);repeat=r.optInt("repeat_days",3);hour=r.optInt("hour",9);key=ReminderRules.policyKey(before,onDue,after,repeat,hour,summary);}
  private static Integer nullable(JSONObject r,String key,int fallback)throws JSONException{return r.has(key)?r.isNull(key)?null:r.getInt(key):fallback;}
  JSONObject json()throws JSONException{return new JSONObject().put("before_days",before==null?JSONObject.NULL:before).put("on_due",onDue).put("after_days",after==null?JSONObject.NULL:after).put("repeat_days",repeat).put("hour",hour).put("daily_summary",summary);}
 }
 static String scope(JSONObject state){if(!"cloud".equals(state.optString("mode")))return "local";JSONObject cloud=state.optJSONObject("cloud");return cloud==null?"":cloud.optString("url")+"/"+cloud.optString("workspaceId");}
 static JSONObject context(JSONObject state,JSONObject stored)throws JSONException{
  String expected=scope(state);if(stored!=null&&expected.equals(stored.optString("scope")))return stored;JSONObject settings=state.optJSONObject("settings");JSONArray consultants=state.optJSONArray("consultants");return new JSONObject().put("scope",expected).put("consultants",consultants==null?new JSONArray():consultants).put("billingRules",new Policy(settings==null?null:settings.optJSONObject("billingRules")).json());
 }
 static void cacheContext(Context c,JSONObject input)throws JSONException{
  synchronized(SecureStore.LOCK){
   JSONObject state=new JSONObject(SecureStore.get(c,"state","{}"));String expected=scope(state);
   if(!expected.equals(input.optString("scope")))throw new IllegalArgumentException("O contexto não pertence à conta ativa.");
   JSONArray consultants=input.optJSONArray("consultants");if(consultants==null||consultants.length()>50000)throw new IllegalArgumentException("Consultores inválidos.");
   Policy policy=new Policy(input.optJSONObject("billingRules"));JSONObject old=new JSONObject(SecureStore.get(c,"reminder_context","{}"));
   if(!expected.equals(old.optString("scope"))){SecureStore.put(c,"invoices","[]");SecureStore.put(c,"invoices_scope",expected);c.getSystemService(NotificationManager.class).cancelAll();}
   SecureStore.put(c,"reminder_context",new JSONObject().put("scope",expected).put("consultants",consultants).put("billingRules",policy.json()).toString());
  }
  DailyReceiver.schedule(c);
 }
 static void cacheInvoices(Context c,JSONArray rows)throws JSONException{
  if(rows.length()>50000)throw new IllegalArgumentException("Muitas notas.");
  synchronized(SecureStore.LOCK){JSONObject state=new JSONObject(SecureStore.get(c,"state","{}")),stored=new JSONObject(SecureStore.get(c,"reminder_context","{}"));String expected=scope(state);if(!expected.equals(stored.optString("scope")))throw new IllegalArgumentException("Atualize o contexto da conta antes das notas.");SecureStore.put(c,"invoices",rows.toString());SecureStore.put(c,"invoices_scope",expected);}
  check(c,rows);
 }
 static int configuredHour(Context c){try{JSONObject state=new JSONObject(SecureStore.get(c,"state","{}")),stored=new JSONObject(SecureStore.get(c,"reminder_context","{}"));return new Policy(context(state,stored).optJSONObject("billingRules")).hour;}catch(Exception invalid){return 9;}}
 static void schedule(Context c){
  NotificationManager n=c.getSystemService(NotificationManager.class);NotificationChannel alerts=new NotificationChannel("reminders","Prazos e resumo de notas",NotificationManager.IMPORTANCE_HIGH);alerts.setDescription("Avisos locais de vencimento e resumo no horário configurado");alerts.enableVibration(true);n.createNotificationChannel(alerts);n.createNotificationChannel(new NotificationChannel("payments","Pagamentos confirmados",NotificationManager.IMPORTANCE_DEFAULT));
  JobScheduler jobs=c.getSystemService(JobScheduler.class);if(jobs.getPendingJob(17)==null)jobs.schedule(new JobInfo.Builder(17,new ComponentName(c,ReminderJob.class)).setPeriodic(6*60*60*1000L,60*60*1000L).setPersisted(true).build());DailyReceiver.schedule(c);
 }
 static void checkNow(Context c){
  if(!enabled(c))return;
  synchronized(SecureStore.LOCK){try{
   JSONObject state=new JSONObject(SecureStore.get(c,"state","{}"));
   JSONArray rows=state.optJSONArray("invoices");
   if(rows==null||rows.length()==0)rows=new JSONArray(SecureStore.get(c,"invoices","[]"));
   if(rows==null||rows.length()==0)return;
   String day=LocalDate.now().toString();
   int unpaid=0,overdue=0,dueToday=0;StringBuilder summary=new StringBuilder();
   for(int n=0;n<rows.length();n++){
    JSONObject row=rows.optJSONObject(n);
    if(row==null||present(row,"paid_at")||present(row,"cancelled_at"))continue;
    String billing=row.optString("billing_date");
    String explicit=row.isNull("due_date")?null:row.optString("due_date");
    int term=row.optInt("term_days",5);
    int days=ReminderRules.daysUntil(billing,term,explicit,day);
    unpaid++;
    if(days<0){
     overdue++;
     if(overdue<=3){
      if(summary.length()>0)summary.append(", ");
      summary.append(row.optString("client_name")).append(" (NF ").append(row.optString("nf_number")).append(")");
     }
    }else if(days==0){dueToday++;}
   }
   if(overdue>0){
    String detail=overdue+" NF(s) em atraso! "+summary.toString();
    show(c,"reminders",300003,"🔴 NotaFlow · Atenção aos Prazos",detail,0xffcc4c4c);
   }else if(dueToday>0){
    show(c,"reminders",300002,"🟡 NotaFlow · Vencendo Hoje",dueToday+" NF(s) com vencimento hoje.",0xffc69422);
   }else if(unpaid>0){
    show(c,"reminders",1003,"🟢 NotaFlow · Recebimentos em dia",unpaid+" NF(s) pendentes dentro do prazo.",0xff087e71);
   }
  }catch(Exception ignored){}}
 }
 @Override public boolean onStartJob(JobParameters params){stopped=false;new Thread(()->{try{if(!MainActivity.active)try{CloudSync.sync(this);}catch(Exception ignored){}if(!stopped)check(this,new JSONArray());}catch(Exception ignored){}finally{jobFinished(params,false);}},"invoice-reminders").start();return true;}
 @Override public boolean onStopJob(JobParameters params){stopped=true;return true;}
 static boolean enabled(Context c){
  try{JSONObject settings=new JSONObject(SecureStore.get(c,"state","{}")).optJSONObject("settings");if(settings!=null&&!settings.optBoolean("notifications",true))return false;}catch(Exception unreadable){return false;}
  NotificationManager n=c.getSystemService(NotificationManager.class);return n.areNotificationsEnabled()&&(Build.VERSION.SDK_INT<33||c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED);
 }
 private static boolean present(JSONObject row,String field){return row.has(field)&&!row.isNull(field)&&!row.optString(field).isEmpty();}
 private static String normalized(String text){return Normalizer.normalize(text,Normalizer.Form.NFD).replaceAll("\\p{M}+","").trim().replaceAll("\\s+"," ").toLowerCase(Locale.ROOT);}
 private static final class Pending {final String id,consultant,kind,key;Pending(String i,String c,String k,String l){id=i;consultant=c;kind=k;key=l;}}
 static void check(Context c,JSONArray ignoredRows){
  if(!enabled(c))return;
  synchronized(SecureStore.LOCK){try{
   JSONObject state=new JSONObject(SecureStore.get(c,"state","{}")),stored=new JSONObject(SecureStore.get(c,"reminder_context","{}"));String scope=scope(state);
   if(scope.isEmpty()||!scope.equals(stored.optString("scope"))||!scope.equals(SecureStore.get(c,"invoices_scope","")))return;
   Policy policy=new Policy(stored.optJSONObject("billingRules"));if(LocalTime.now().isBefore(LocalTime.of(policy.hour,0)))return;
   String day=LocalDate.now().toString();JSONArray rows=new JSONArray(SecureStore.get(c,"invoices","[]")),consultants=stored.optJSONArray("consultants");
   Map<String,JSONObject> byId=new HashMap<>(),byName=new HashMap<>();if(consultants!=null)for(int n=0;n<consultants.length();n++){JSONObject consultant=consultants.optJSONObject(n);if(consultant!=null){byId.put(consultant.optString("id"),consultant);byName.put(normalized(consultant.optString("name")),consultant);}}
   JSONObject ledger=new JSONObject(SecureStore.get(c,"reminder_ledger","{}"));JSONArray log=new JSONArray(SecureStore.get(c,"notification_log","[]"));Map<String,List<Pending>> groups=new LinkedHashMap<>();int unpaid=0,overdue=0,tomorrow=0,dueToday=0;
   for(int n=0;n<rows.length();n++){JSONObject row=rows.optJSONObject(n);if(row==null||present(row,"paid_at")||present(row,"cancelled_at"))continue;try{
    JSONObject consultant=byId.get(row.optString("consultant_id"));if(consultant==null)consultant=byName.get(normalized(row.optString("consultant")));
    if(!ReminderRules.eligible(consultant!=null,consultant!=null&&consultant.optBoolean("active",true),consultant!=null&&consultant.optBoolean("notifications_enabled",true)))continue;
    String billing=row.getString("billing_date"),explicit=row.isNull("due_date")?null:row.optString("due_date"),due=ReminderRules.dueDate(billing,row.getInt("term_days"),explicit);int days=ReminderRules.daysUntil(billing,row.getInt("term_days"),explicit,day);
    unpaid++;if(days<0)overdue++;else if(days==0)dueToday++;else if(days==1)tomorrow++;
    String kind=ReminderRules.trigger(billing,row.getInt("term_days"),explicit,false,false,day,policy.before,policy.onDue,policy.after,policy.repeat),id=row.optString("id");if(kind.isEmpty()||id.isEmpty())continue;
    String key=ReminderRules.ledgerKey(scope,id,due,kind,day,policy.key);if(ledger.has(key))continue;
    String consultantId=consultant==null?"":consultant.optString("id");List<Pending> group=groups.get(kind);if(group==null){group=new ArrayList<>();groups.put(kind,group);}group.add(new Pending(id,consultantId,kind,key));
   }catch(Exception invalidRow){}}
   String summaryKey=ReminderRules.ledgerKey(scope,"summary","","summary",day,policy.key);boolean changed=false;
   if(policy.summary&&!ledger.has(summaryKey)){
    String title=overdue>0?"🔴 Seu resumo diário":unpaid>0?"🟡 Seu resumo diário":"🟢 Seu controle está em dia";
    String message=unpaid==0?"Nenhuma NF elegível com pagamento pendente. Abra o NotaFlow para acompanhar seus recebimentos.":unpaid+" NF(s) não pagas: "+overdue+" atrasada(s), "+dueToday+" vencendo hoje e "+tomorrow+" com vencimento amanhã. Aviso neste dispositivo; nenhum WhatsApp foi enviado.";
    if(show(c,"reminders",1003,title,message,overdue>0?0xffcc4c4c:unpaid>0?0xffc69422:0xff087e71)){ledger.put(summaryKey,day);for(List<Pending> group:groups.values())for(Pending pending:group)record(ledger,log,scope,day,pending);changed=true;groups.clear();}
   }
   for(Map.Entry<String,List<Pending>> entry:groups.entrySet()){
    String kind=entry.getKey();List<Pending> group=entry.getValue();String label=kind.equals("before")?"próxima(s) do vencimento":kind.equals("due")?"vencendo hoje":"em atraso";int notificationId=kind.equals("before")?300001:kind.equals("due")?300002:300003;
    if(show(c,"reminders",notificationId,"NotaFlow · atenção aos prazos",group.size()+" NF(s) "+label+". Abra para acompanhar. Este é um aviso local; nenhum WhatsApp foi enviado.",kind.equals("overdue")?0xffcc4c4c:0xffc69422)){for(Pending pending:group)record(ledger,log,scope,day,pending);changed=true;}
   }
   if(changed){pruneLedger(ledger,day);JSONArray bounded=new JSONArray();for(int n=Math.max(0,log.length()-MAX_LOG);n<log.length();n++)bounded.put(log.get(n));SecureStore.put(c,"reminder_ledger",ledger.toString());SecureStore.put(c,"notification_log",bounded.toString());}
  }catch(Exception protectedData){/* Keep encrypted data unchanged if unavailable. */}}
 }
 private static void record(JSONObject ledger,JSONArray log,String scope,String day,Pending pending)throws JSONException{ledger.put(pending.key,day);log.put(new JSONObject().put("id",UUID.randomUUID().toString()).put("scope",scope).put("invoice_id",pending.id).put("consultant_id",pending.consultant.isEmpty()?JSONObject.NULL:pending.consultant).put("channel","local").put("status","shown").put("kind",pending.kind).put("created_at",Instant.now().toString()));}
 private static void pruneLedger(JSONObject ledger,String day)throws JSONException{
  String cutoff=LocalDate.parse(day).minusDays(31).toString();List<String> keys=new ArrayList<>();Iterator<String> iterator=ledger.keys();while(iterator.hasNext())keys.add(iterator.next());for(String key:keys)if(ledger.optString(key).compareTo(cutoff)<0)ledger.remove(key);
  if(ledger.length()>MAX_LEDGER){keys.clear();iterator=ledger.keys();while(iterator.hasNext())keys.add(iterator.next());keys.sort(Comparator.comparing(ledger::optString));for(int n=0;n<keys.size()-MAX_LEDGER;n++)ledger.remove(keys.get(n));}
 }
 static String readNotificationLog(Context c){synchronized(SecureStore.LOCK){try{String scope=scope(new JSONObject(SecureStore.get(c,"state","{}")));JSONArray source=new JSONArray(SecureStore.get(c,"notification_log","[]")),out=new JSONArray();for(int n=0;n<source.length();n++){JSONObject row=source.optJSONObject(n);if(row!=null&&scope.equals(row.optString("scope"))){JSONObject visible=new JSONObject(row.toString());visible.remove("scope");out.put(visible);}}return out.toString();}catch(Exception unreadable){return "[]";}}}
 static void payment(Context c,String client,String nf){if(enabled(c))show(c,"payments",2000+Math.abs((client+nf).hashCode()%100000),"🟢 Pagamento realizado",client+" • NF "+nf+" marcada como paga.",0xff087e71);}
 private static boolean show(Context c,String channel,int id,String title,String message,int color){try{NotificationManager n=c.getSystemService(NotificationManager.class);if(n.getNotificationChannel(channel)!=null&&n.getNotificationChannel(channel).getImportance()==NotificationManager.IMPORTANCE_NONE)return false;Intent i=new Intent(c,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);PendingIntent pi=PendingIntent.getActivity(c,0,i,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);n.notify(id,new Notification.Builder(c,channel).setSmallIcon(br.com.notaflow.R.drawable.ic_notification).setContentTitle(title).setContentText(message).setStyle(new Notification.BigTextStyle().bigText(message)).setColor(color).setAutoCancel(true).setContentIntent(pi).setVisibility(Notification.VISIBILITY_PRIVATE).build());return true;}catch(SecurityException e){return false;}}
}
