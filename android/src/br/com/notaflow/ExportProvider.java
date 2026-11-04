package br.com.notaflow;
import android.content.*;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.*;

/** Narrow, temporary read grants for files created by the app's export action. */
public final class ExportProvider extends ContentProvider {
 public boolean onCreate(){return true;}
 private File file(Uri uri)throws FileNotFoundException{String n=uri.getLastPathSegment();if(n==null||!n.matches("[a-zA-Z0-9][a-zA-Z0-9._-]*"))throw new FileNotFoundException();File dir=new File(getContext().getCacheDir(),"exports");File f=new File(dir,n);try{if(!f.getCanonicalFile().getParentFile().equals(dir.getCanonicalFile())||!f.isFile())throw new FileNotFoundException();}catch(IOException e){throw new FileNotFoundException();}return f;}
 public ParcelFileDescriptor openFile(Uri u,String mode)throws FileNotFoundException{if(!"r".equals(mode))throw new FileNotFoundException();return ParcelFileDescriptor.open(file(u),ParcelFileDescriptor.MODE_READ_ONLY);}
 public String getType(Uri u){return u.toString().endsWith(".csv")?"text/csv":"application/json";}
 public Cursor query(Uri u,String[] projection,String selection,String[] args,String order){try{File f=file(u);MatrixCursor c=new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE});c.addRow(new Object[]{f.getName(),f.length()});return c;}catch(FileNotFoundException e){return null;}}
 public Uri insert(Uri u,ContentValues v){throw new UnsupportedOperationException();}public int delete(Uri u,String s,String[] a){throw new UnsupportedOperationException();}public int update(Uri u,ContentValues v,String s,String[] a){throw new UnsupportedOperationException();}
}
