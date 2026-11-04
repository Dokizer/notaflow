package br.com.notaflow;
import java.net.URLEncoder;
import java.io.UnsupportedEncodingException;

/** Builds a manual composer URL; it has no API credentials or send operation. */
final class ManualWhatsApp {
 static String url(String phone,String message){
  String value=phone==null?"":phone.trim();
  if(!value.matches("\\+?[1-9][0-9]{7,14}")||message==null||message.trim().isEmpty()||message.length()>6000)throw new IllegalArgumentException("Telefone ou mensagem inválidos.");
  String digits=value.startsWith("+")?value.substring(1):value;
  try{return "https://wa.me/"+digits+"?text="+URLEncoder.encode(message,"UTF-8").replace("+","%20");}catch(UnsupportedEncodingException impossible){throw new IllegalStateException(impossible);}
 }
}
