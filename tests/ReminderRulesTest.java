package br.com.notaflow;
public final class ReminderRulesTest {
 private static void eq(Object a,Object b){if(!a.equals(b))throw new AssertionError(a+" != "+b);}
 private static Object call(String name,Class<?>[] types,Object... args){try{return ReminderRules.class.getDeclaredMethod(name,types).invoke(null,args);}catch(ReflectiveOperationException e){Throwable cause=e instanceof java.lang.reflect.InvocationTargetException?e.getCause():e;throw new AssertionError("Regra nativa V2 ausente ou incorreta: "+name,cause);}}
 private static String trigger(String billing,int term,String due,boolean paid,boolean cancelled,String today,Integer before,boolean onDue,Integer after,int repeat){return (String)call("trigger",new Class<?>[]{String.class,int.class,String.class,boolean.class,boolean.class,String.class,Integer.class,boolean.class,Integer.class,int.class},billing,term,due,paid,cancelled,today,before,onDue,after,repeat);}
 private static String ledger(String scope,String invoice,String due,String kind,String day,String policy){return (String)call("ledgerKey",new Class<?>[]{String.class,String.class,String.class,String.class,String.class,String.class},scope,invoice,due,kind,day,policy);}
 public static void main(String[] args){
  eq(ReminderRules.daysUntil("2026-10-29",5,"2026-11-02"),1);
  eq(ReminderRules.kind("2026-10-29",5,false,"2026-11-03"),"pending");
  eq(ReminderRules.kind("2026-10-29",5,false,"2026-11-04"),"overdue");
  eq(ReminderRules.kind("2026-10-29",5,true,"2026-11-04"),"paid");
  eq(ReminderRules.daysUntil("2024-02-28",2,"2024-03-01"),0);
  eq(ReminderRules.daysUntil("2026-12-31",1,"2027-01-01"),0);
  eq(ReminderRules.daysUntil("2026-10-29",0,"2026-10-29"),0);
  eq(ReminderRules.shouldSendDaily("2026-10-29",""),true);
  eq(ReminderRules.shouldSendDaily("2026-10-29","2026-10-29"),false);
  eq(ReminderRules.shouldSendDaily("2026-10-30","2026-10-29"),true);
  eq(ReminderRules.shouldSendDaily("2026-10-28","2026-10-29"),false);
  eq(ReminderRules.nextDaily(java.time.ZonedDateTime.parse("2026-10-29T08:59:00-03:00")).toString(),"2026-10-29T09:00-03:00");
  eq(ReminderRules.nextDaily(java.time.ZonedDateTime.parse("2026-10-29T09:00:00-03:00")).toString(),"2026-10-30T09:00-03:00");
  try{ReminderRules.kind("2026-02-29",5,false,"2026-11-04");throw new AssertionError("Aceitou data impossível");}catch(java.time.format.DateTimeParseException expected){}
  eq(call("dueDate",new Class<?>[]{String.class,int.class,String.class},"2026-10-29",5,"2026-11-10"),"2026-11-10");
  eq(trigger("2026-10-29",5,null,false,false,"2026-11-02",1,true,1,3),"before");
  eq(trigger("2026-10-29",5,null,false,false,"2026-11-03",1,true,1,3),"due");
  eq(trigger("2026-10-29",5,null,false,false,"2026-11-04",1,true,1,3),"overdue");
  eq(trigger("2026-10-29",5,null,false,false,"2026-11-05",1,true,1,3),"");
  eq(trigger("2026-10-29",5,null,false,false,"2026-11-07",1,true,1,3),"overdue");
  eq(trigger("2026-10-29",5,null,false,false,"2026-11-10",1,true,1,3),"overdue");
  eq(trigger("2026-10-29",5,"2026-11-10",false,false,"2026-11-09",1,true,1,3),"before");
  eq(trigger("2026-10-29",5,null,true,false,"2026-11-04",1,true,1,3),"");
  eq(trigger("2026-10-29",5,null,false,true,"2026-11-04",1,true,1,3),"");
  eq(trigger("2026-10-29",5,null,false,false,"2026-11-02",null,true,1,3),"");
  eq(trigger("2026-10-29",5,null,false,false,"2026-11-03",1,false,1,3),"");
  eq(trigger("2026-10-29",5,null,false,false,"2026-11-07",1,true,null,3),"");
  eq(trigger("2026-10-29",5,null,false,false,"2026-11-04",1,true,1,0),"overdue");
  eq(trigger("2026-10-29",5,null,false,false,"2026-11-07",1,true,1,0),"");
  eq(trigger("2026-10-29",5,null,false,false,"2026-11-06",2,true,3,2),"overdue");
  eq(trigger("2026-10-29",5,null,false,false,"2026-11-08",2,true,3,2),"overdue");
  eq(call("eligible",new Class<?>[]{boolean.class,boolean.class,boolean.class},true,true,true),true);
  eq(call("eligible",new Class<?>[]{boolean.class,boolean.class,boolean.class},true,false,true),false);
  eq(call("eligible",new Class<?>[]{boolean.class,boolean.class,boolean.class},true,true,false),false);
  eq(call("eligible",new Class<?>[]{boolean.class,boolean.class,boolean.class},false,false,false),true);
  eq(call("nextDaily",new Class<?>[]{java.time.ZonedDateTime.class,int.class},java.time.ZonedDateTime.parse("2026-10-29T08:59:00-03:00"),8).toString(),"2026-10-30T08:00-03:00");
  String key=ledger("account-A","invoice-1","2026-11-03","due","2026-11-03","policy-1");
  eq(key,ledger("account-A","invoice-1","2026-11-03","due","2026-11-03","policy-1"));
  eq(key.equals(ledger("account-B","invoice-1","2026-11-03","due","2026-11-03","policy-1")),false);
  eq(key.equals(ledger("account-A","invoice-2","2026-11-03","due","2026-11-03","policy-1")),false);
  eq(key.equals(ledger("account-A","invoice-1","2026-11-04","due","2026-11-03","policy-1")),false);
  eq(key.equals(ledger("account-A","invoice-1","2026-11-03","before","2026-11-03","policy-1")),false);
  eq(key.equals(ledger("account-A","invoice-1","2026-11-03","due","2026-11-04","policy-1")),false);
  eq(key.equals(ledger("account-A","invoice-1","2026-11-03","due","2026-11-03","policy-2")),false);
  System.out.println("43 verificações de regras nativas passaram.");
 }
}
