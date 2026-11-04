package com.epubmaster.app;

import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 把压缩后的 EPUB 保存到手机公共「下载/EPUB Master」目录。
 *
 * 采用「分块写入」：begin → writeChunk × N → finish。
 * 一整本 EPUB 转成 Base64 后有好几 MB，一次性通过 WebView 桥接传递会超出
 * 单次调用上限而被截断，导致解码失败。分块后每次只传 256KB，稳定可靠。
 *
 * Android 10+ 走 MediaStore，无需任何存储权限，也不会出现父目录不存在的问题；
 * Android 7-9 走传统 File 写入（manifest 已声明 maxSdkVersion=28 的写权限）。
 */
@CapacitorPlugin(name = "DownloadSaver")
public class DownloadSaverPlugin extends Plugin {

    private static final String MIME = "application/epub+zip";
    private static final String FOLDER = "EPUB Master";

    private OutputStream stream;
    private Uri targetUri;
    private File targetFile;
    private String targetName;
    private long written;

    private void closeStreamQuietly() {
        if (stream != null) {
            try { stream.flush(); } catch (Exception ignored) { }
            try { stream.close(); } catch (Exception ignored) { }
            stream = null;
        }
    }

    private void resetAll() {
        closeStreamQuietly();
        targetUri = null;
        targetFile = null;
        targetName = null;
        written = 0;
    }

    /** 第一步：创建目标文件，打开写入流 */
    @PluginMethod
    public void begin(PluginCall call) {
        String fileName = call.getString("fileName", "book_compressed.epub");
        resetAll();

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                values.put(MediaStore.Downloads.MIME_TYPE, MIME);
                values.put(MediaStore.Downloads.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER);
                values.put(MediaStore.Downloads.IS_PENDING, 1);

                Uri uri = getContext().getContentResolver()
                        .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    call.reject("系统拒绝创建文件");
                    return;
                }
                OutputStream os = getContext().getContentResolver().openOutputStream(uri);
                if (os == null) {
                    getContext().getContentResolver().delete(uri, null, null);
                    call.reject("无法打开输出流");
                    return;
                }
                targetUri = uri;
                stream = os;
                targetName = fileName;
            } else {
                File dir = new File(
                        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                        FOLDER);
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("无法创建下载目录");
                    return;
                }
                File f = new File(dir, fileName);
                stream = new FileOutputStream(f);
                targetFile = f;
                targetName = fileName;
            }

            written = 0;
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            resetAll();
            call.reject("创建文件失败：" + e.getMessage());
        }
    }

    /** 第二步：写入一块 Base64 数据（每块长度是 4 的倍数，块间无填充） */
    @PluginMethod
    public void writeChunk(PluginCall call) {
        String chunk = call.getString("chunk");
        if (chunk == null || chunk.isEmpty()) {
            call.reject("收到空数据块");
            return;
        }
        if (stream == null) {
            call.reject("写入流已关闭，请重新开始");
            return;
        }

        byte[] bytes;
        try {
            bytes = Base64.decode(chunk, Base64.DEFAULT);
        } catch (Exception e) {
            call.reject("数据块解码失败（长度 " + chunk.length() + "）：" + e.getMessage());
            return;
        }

        try {
            stream.write(bytes);
            written += bytes.length;
            JSObject ret = new JSObject();
            ret.put("written", written);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("写入数据失败：" + e.getMessage());
        }
    }

    /** 第三步：收尾，落盘并公布真实文件名 */
    @PluginMethod
    public void finish(PluginCall call) {
        if (stream == null) {
            call.reject("没有正在写入的文件");
            return;
        }
        try {
            closeStreamQuietly();

            String uriStr;
            String display;
            String actualName = targetName;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && targetUri != null) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                getContext().getContentResolver().update(targetUri, values, null, null);

                // 系统可能因同名文件自动改名，回读真实文件名
                android.database.Cursor c = getContext().getContentResolver().query(
                        targetUri, new String[]{MediaStore.Downloads.DISPLAY_NAME},
                        null, null, null);
                if (c != null) {
                    if (c.moveToFirst()) {
                        String n = c.getString(0);
                        if (n != null && !n.isEmpty()) actualName = n;
                    }
                    c.close();
                }
                uriStr = targetUri.toString();
            } else if (targetFile != null) {
                uriStr = FileProvider.getUriForFile(
                        getContext(), getContext().getPackageName() + ".fileprovider", targetFile)
                        .toString();
            } else {
                call.reject("目标文件不存在");
                return;
            }

            display = "下载/" + FOLDER + "/" + actualName;

            JSObject ret = new JSObject();
            ret.put("uri", uriStr);
            ret.put("path", display);
            ret.put("name", actualName);
            ret.put("bytes", written);
            call.resolve(ret);

            resetAll();
        } catch (Exception e) {
            resetAll();
            call.reject("保存失败：" + e.getMessage());
        }
    }

    /** 放弃本次写入（取消或出错时调用），不留半截文件 */
    @PluginMethod
    public void abort(PluginCall call) {
        try {
            closeStreamQuietly();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && targetUri != null) {
                getContext().getContentResolver().delete(targetUri, null, null);
            } else if (targetFile != null && targetFile.exists()) {
                targetFile.delete();
            }
        } catch (Exception ignored) {
        }
        resetAll();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /** 用系统阅读器打开已保存的文件 */
    @PluginMethod
    public void open(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null || uriStr.isEmpty()) {
            call.reject("没有文件地址");
            return;
        }
        try {
            Uri uri = Uri.parse(uriStr);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, MIME);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);

            if (intent.resolveActivity(getContext().getPackageManager()) == null) {
                call.reject("手机上还没有能打开 EPUB 的阅读器");
                return;
            }

            getActivity().startActivity(Intent.createChooser(intent, "用其他应用打开"));
            call.resolve();
        } catch (Exception e) {
            call.reject("打开失败：" + e.getMessage());
        }
    }
}
