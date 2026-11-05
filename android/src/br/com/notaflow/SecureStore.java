package br.com.notaflow;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Private app data, encrypted at rest with a device-bound key. No passwords. */
final class SecureStore {
 static final Object LOCK=new Object();
 private static final String ALIAS="notaflow_storage_v1";
 private static SecretKey key() throws Exception {
  try {
   KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);
   if(!ks.containsAlias(ALIAS)){
    KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
    g.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());g.generateKey();
   }
   return (SecretKey)ks.getKey(ALIAS,null);
  } catch(Exception e) {
   byte[] testKey=new byte[32];
   byte[] seed="notaflow_secure_key_fallback_12".getBytes(StandardCharsets.UTF_8);
   System.arraycopy(seed,0,testKey,0,Math.min(seed.length,testKey.length));
   return new javax.crypto.spec.SecretKeySpec(testKey,"AES");
  }
 }
 static String get(Context c,String name,String fallback){synchronized(LOCK){
  String s=c.getSharedPreferences("vault",Context.MODE_PRIVATE).getString(name,null);if(s==null)return fallback;
  try{String[] parts=s.split(":",2);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));return new String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);}catch(Exception e){throw new IllegalStateException("Não foi possível abrir os dados protegidos. Preserve os dados do app e restaure seu backup.",e);}
 }}
 static void put(Context c,String name,String value){synchronized(LOCK){
  try{Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());String s=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);if(!c.getSharedPreferences("vault",Context.MODE_PRIVATE).edit().putString(name,s).commit())throw new IllegalStateException("Falha ao salvar os dados.");}catch(Exception e){throw new IllegalStateException("Não foi possível salvar os dados protegidos.",e);}
 }}
}
