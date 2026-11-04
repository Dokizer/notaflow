package br.com.notaflow;
import android.content.*;
public final class BootReceiver extends BroadcastReceiver {public void onReceive(Context c,Intent i){ReminderJob.schedule(c);}}
