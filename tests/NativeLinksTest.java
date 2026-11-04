package br.com.notaflow;
import java.lang.reflect.*;
import java.net.URI;
import java.net.URLDecoder;
public final class NativeLinksTest {
 private static String link(String phone,String message){try{Class<?> type=Class.forName("br.com.notaflow.ManualWhatsApp");return (String)type.getDeclaredMethod("url",String.class,String.class).invoke(null,phone,message);}catch(InvocationTargetException e){if(e.getCause() instanceof IllegalArgumentException)throw (IllegalArgumentException)e.getCause();throw new AssertionError(e.getCause());}catch(ReflectiveOperationException e){throw new AssertionError("Preparação manual WhatsApp ausente",e);}}
 public static void main(String[] args)throws Exception{
  String message="Olá, João!\nNF 00123 · R$ 1.234,56\n+ & ? # /";
  URI uri=new URI(link("+5571999999999",message));
  if(!"https".equals(uri.getScheme())||!"wa.me".equals(uri.getHost())||!"/5571999999999".equals(uri.getPath()))throw new AssertionError(uri);
  if(!message.equals(URLDecoder.decode(uri.getRawQuery().substring(5),"UTF-8")))throw new AssertionError("Mensagem alterada");
  if(!link("5571999999999",message).equals(uri.toString()))throw new AssertionError("Normalização do código do país incorreta");
  for(String invalid:new String[]{"","0","071999999999","+55;evil","https://evil.example","++5571999999999","+5571?text=x","+1234567890123456"}){try{link(invalid,message);throw new AssertionError("Aceitou telefone: "+invalid);}catch(IllegalArgumentException expected){}}
  for(String invalid:new String[]{"","   ",new String(new char[6001]).replace('\0','a')}){try{link("+5571999999999",invalid);throw new AssertionError("Aceitou mensagem inválida");}catch(IllegalArgumentException expected){}}
  System.out.println("14 verificações do link manual WhatsApp passaram; nenhum envio executado.");
 }
}
