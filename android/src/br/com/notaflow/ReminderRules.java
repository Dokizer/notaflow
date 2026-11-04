package br.com.notaflow;
import java.time.LocalDate;
import java.time.ZonedDateTime;
import java.time.temporal.ChronoUnit;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Date-only rules; no Android or messaging dependency. */
final class ReminderRules {
 static boolean shouldSendDaily(String today,String last){LocalDate day=date(today);if(last==null||last.isEmpty())return true;try{return day.isAfter(date(last));}catch(RuntimeException invalid){return true;}}
 static ZonedDateTime nextDaily(ZonedDateTime now){return nextDaily(now,9);}
 static ZonedDateTime nextDaily(ZonedDateTime now,int hour){if(hour<0||hour>23)throw new IllegalArgumentException("Hora inválida");ZonedDateTime next=now.withHour(hour).withMinute(0).withSecond(0).withNano(0);return next.isAfter(now)?next:next.plusDays(1);}
 private static LocalDate date(String value){if(value==null||!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}"))throw new IllegalArgumentException("Data inválida");LocalDate day=LocalDate.parse(value);if(day.getYear()<1900||day.getYear()>2200)throw new IllegalArgumentException("Data fora do intervalo");return day;}
 static String dueDate(String billing,int term,String explicit){if(term<0||term>3650)throw new IllegalArgumentException("Prazo inválido");LocalDate start=date(billing),due=explicit==null||explicit.isEmpty()?start.plusDays(term):date(explicit);if(due.isBefore(start))throw new IllegalArgumentException("Vencimento anterior ao faturamento");return due.toString();}
 static int daysUntil(String billing,int term,String today){return daysUntil(billing,term,null,today);}
 static int daysUntil(String billing,int term,String explicit,String today){return (int)ChronoUnit.DAYS.between(date(today),date(dueDate(billing,term,explicit)));}
 static String kind(String billing,int term,boolean paid,String today){if(paid)return "paid";int days=daysUntil(billing,term,today);return days<0?"overdue":days==1?"tomorrow":"pending";}
 private static void interval(Integer value){if(value!=null&&(value<1||value>3650))throw new IllegalArgumentException("Intervalo inválido");}
 static String policyKey(Integer before,boolean onDue,Integer after,int repeat,int hour,boolean summary){interval(before);interval(after);if(repeat<0||repeat>3650||hour<0||hour>23)throw new IllegalArgumentException("Política inválida");return before+":"+onDue+":"+after+":"+repeat+":"+hour+":"+summary;}
 static String trigger(String billing,int term,String due,boolean paid,boolean cancelled,String today,Integer before,boolean onDue,Integer after,int repeat){
  if(paid||cancelled)return "";policyKey(before,onDue,after,repeat,9,true);int days=daysUntil(billing,term,due,today);
  if(before!=null&&days==before)return "before";if(days==0&&onDue)return "due";
  if(after!=null&&days<0){int elapsed=-days-after;if(elapsed==0||elapsed>0&&repeat>0&&elapsed%repeat==0)return "overdue";}return "";
 }
 static boolean eligible(boolean consultantPresent,boolean active,boolean notificationsEnabled){return !consultantPresent||active&&notificationsEnabled;}
 static String ledgerKey(String scope,String invoice,String due,String kind,String day,String policy){
  try{MessageDigest digest=MessageDigest.getInstance("SHA-256");for(String value:new String[]{scope,invoice,due,kind,day,policy}){String part=value==null?"":value;digest.update((part.length()+":"+part).getBytes(StandardCharsets.UTF_8));}StringBuilder hex=new StringBuilder();for(byte b:digest.digest())hex.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return hex.toString();}catch(java.security.NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}
 }
}
