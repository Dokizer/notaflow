package br.com.notaflow;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.*;
import android.view.View;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public final class MainActivity extends Activity {
 static volatile boolean active;
 private WebView web;
 static final String ORIGIN="https://app.notaflow.local/";
 @Override public void onCreate(Bundle b){super.onCreate(b);
  web=new WebView(this);web.setBackgroundColor(0xfff6f7f3);setContentView(web);
  WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setJavaScriptCanOpenWindowsAutomatically(false);s.setSupportMultipleWindows(false);s.setMediaPlaybackRequiresUserGesture(true);
  CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
  web.setWebViewClient(new WebViewClient(){
   @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return !ORIGIN.equals(r.getUrl().toString())&&!r.getUrl().toString().startsWith(ORIGIN+"index.html");}
   @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r){
    Uri u=r.getUrl();if(!"app.notaflow.local".equals(u.getHost()))return null;
    String p=u.getPath();if(p==null||p.equals("/"))p="/index.html";
    if(!p.matches("/[a-zA-Z0-9._-]+"))return new WebResourceResponse("text/plain","UTF-8",403,"Forbidden",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));
    String mime=p.endsWith(".js")?"application/javascript":p.endsWith(".css")?"text/css":p.endsWith(".html")?"text/html":p.endsWith(".svg")?"image/svg+xml":"application/octet-stream";
    try{Map<String,String> h=new HashMap<>();h.put("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src https://*.supabase.co https://*.supabase.in; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'");h.put("Cache-Control","no-store");return new WebResourceResponse(mime,"UTF-8",200,"OK",h,getAssets().open(p.substring(1)));}catch(IOException e){return new WebResourceResponse("text/plain","UTF-8",404,"Not Found",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
   }
  });
  web.setWebChromeClient(new WebChromeClient(){
   @Override public boolean onJsAlert(WebView v,String u,String message,JsResult result){new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("OK",(d,w)->result.confirm()).setOnCancelListener(d->result.cancel()).show();return true;}
   @Override public boolean onJsConfirm(WebView v,String u,String message,JsResult result){new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("Confirmar",(d,w)->result.confirm()).setNegativeButton("Cancelar",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show();return true;}
   @Override public boolean onShowFileChooser(WebView v,ValueCallback<Uri[]> callback,FileChooserParams params){if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=callback;try{Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);String accepts=Arrays.toString(params.getAcceptTypes()).toLowerCase(Locale.ROOT);if(accepts.contains("json")&&!accepts.contains("csv")&&!accepts.contains("xls"))i.setType("application/json");else{i.setType("*/*");i.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.ms-excel","text/csv","text/comma-separated-values","application/csv","text/plain","application/octet-stream"});}startActivityForResult(i,42);}catch(Exception e){callback.onReceiveValue(null);fileCallback=null;}return true;}
  });
  web.addJavascriptInterface(new Bridge(),"Native");
  ReminderJob.schedule(this);web.loadUrl(ORIGIN);
 }
 private ValueCallback<Uri[]> fileCallback;
 @Override protected void onStart(){super.onStart();active=true;}
 @Override protected void onStop(){active=false;super.onStop();}
 @Override protected void onActivityResult(int req,int result,Intent data){super.onActivityResult(req,result,data);if(req==42&&fileCallback!=null){fileCallback.onReceiveValue(result==RESULT_OK&&data!=null?new Uri[]{data.getData()}:null);fileCallback=null;}}
 @Override protected void onResume(){super.onResume();if(web!=null)web.evaluateJavascript("window.dispatchEvent(new Event('native-resume'))",null);}
 @Override public void onBackPressed(){web.evaluateJavascript("(function(){if(typeof window.NFBack==='function')return window.NFBack();return false;})()",v->{if(!"true".equals(v))new AlertDialog.Builder(this).setMessage("Fechar o NotaFlow?").setPositiveButton("Fechar",(d,w)->finish()).setNegativeButton("Continuar",null).show();});}
 public final class Bridge {
  @JavascriptInterface public String readState(){return SecureStore.get(MainActivity.this,"state","{}");}
  @JavascriptInterface public void writeState(String json){if(json==null||json.length()>12000000)throw new IllegalArgumentException("Dados muito grandes.");try{new JSONObject(json);}catch(JSONException e){throw new IllegalArgumentException("Dados inválidos.");}SecureStore.put(MainActivity.this,"state",json);}
  @JavascriptInterface public void cacheContext(String json){if(json==null||json.length()>12000000)throw new IllegalArgumentException("Contexto muito grande.");try{ReminderJob.cacheContext(MainActivity.this,new JSONObject(json));}catch(JSONException e){throw new IllegalArgumentException("Contexto inválido.");}}
  @JavascriptInterface public void cacheInvoices(String json){if(json==null||json.length()>12000000)throw new IllegalArgumentException("Notas muito grandes.");try{ReminderJob.cacheInvoices(MainActivity.this,new JSONArray(json));}catch(JSONException e){throw new IllegalArgumentException("Notas inválidas.");}}
  @JavascriptInterface public String readNotificationLog(){return ReminderJob.readNotificationLog(MainActivity.this);}
  @JavascriptInterface public boolean openWhatsApp(String phone,String message){
   final String url;try{url=ManualWhatsApp.url(phone,message);}catch(IllegalArgumentException invalid){return false;}
   final AtomicBoolean opened=new AtomicBoolean(false),pending=new AtomicBoolean(true);final CountDownLatch completed=new CountDownLatch(1);
   Runnable launch=()->{if(!pending.compareAndSet(true,false)){completed.countDown();return;}try{if(!isFinishing()&&!isDestroyed()){startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url)));opened.set(true);}}catch(android.content.ActivityNotFoundException|SecurityException unavailable){}finally{completed.countDown();}};
   if(Looper.myLooper()==Looper.getMainLooper())launch.run();else{runOnUiThread(launch);try{if(!completed.await(3,TimeUnit.SECONDS)){pending.set(false);return false;}}catch(InterruptedException interrupted){pending.set(false);Thread.currentThread().interrupt();return false;}}
   return opened.get();
  }
  @JavascriptInterface public void paymentNotification(String client,String nf){ReminderJob.payment(MainActivity.this,client,nf);}
  @JavascriptInterface public boolean notificationsEnabled(){NotificationManager n=getSystemService(NotificationManager.class);return n.areNotificationsEnabled()&&(Build.VERSION.SDK_INT<33||checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED);}
  @JavascriptInterface public void requestNotifications(){runOnUiThread(()->{if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},10);else if(!notificationsEnabled())openNotificationSettings();});}
  @JavascriptInterface public void openNotificationSettings(){runOnUiThread(()->startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,getPackageName())));}
  @JavascriptInterface public void shareFile(String name,String content,String mime){
   if(content==null||content.length()>15000000)throw new IllegalArgumentException("Arquivo muito grande.");
   final String safe=name==null?"notaflow.json":name.replaceAll("[^a-zA-Z0-9._-]","_");
   if(safe.isEmpty()||safe.startsWith("."))throw new IllegalArgumentException("Nome inválido.");
   try{File dir=new File(getCacheDir(),"exports");dir.mkdirs();File[] old=dir.listFiles();if(old!=null)for(File f:old)if(f.lastModified()<System.currentTimeMillis()-86400000)f.delete();File file=new File(dir,safe);try(FileOutputStream out=new FileOutputStream(file)){out.write(content.getBytes(StandardCharsets.UTF_8));}
    final Uri uri=Uri.parse("content://br.com.notaflow.exports/"+Uri.encode(safe));final String type=mime!=null&&mime.equals("text/csv")?"text/csv":"application/json";
    runOnUiThread(()->{Intent i=new Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);i.setClipData(android.content.ClipData.newRawUri(safe,uri));startActivity(Intent.createChooser(i,"Salvar ou compartilhar"));});
   }catch(IOException e){throw new IllegalStateException("Não foi possível exportar.",e);}
  }
 }
}
