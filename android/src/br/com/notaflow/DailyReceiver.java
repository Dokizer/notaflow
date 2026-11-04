package br.com.notaflow;
import android.app.*;
import android.app.job.*;
import android.content.*;
import java.time.*;
import org.json.JSONArray;

/** Inexact native daily wakeup, with no exact-alarm or battery exemption permission. */
public final class DailyReceiver extends BroadcastReceiver {
 static void schedule(Context context){
  ZonedDateTime next=ReminderRules.nextDaily(ZonedDateTime.now(),ReminderJob.configuredHour(context));
  PendingIntent intent=PendingIntent.getBroadcast(context,91,new Intent(context,DailyReceiver.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
  context.getSystemService(AlarmManager.class).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,next.toInstant().toEpochMilli(),intent);
 }
 @Override public void onReceive(Context context,Intent intent){
  schedule(context);
  context.getSystemService(JobScheduler.class).schedule(new JobInfo.Builder(18,new ComponentName(context,ReminderJob.class)).setOverrideDeadline(30*60*1000L).build());
  final PendingResult pending=goAsync();
  new Thread(()->{try{ReminderJob.check(context,new JSONArray(SecureStore.get(context,"invoices","[]")));}catch(Exception ignored){}finally{pending.finish();}},"daily-local-summary").start();
 }
}
