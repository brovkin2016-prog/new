package app.aihelper.family;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/** Saving results to the phone (pictures to Pictures, the rest to Downloads) and sharing them. */
final class Files {
    static final String DIR = "ИИ-помощник";

    private Files() {}

    static String authority(Activity a) {
        return a.getPackageName() + ".files";
    }

    static void save(Activity a, String name, String mime, byte[] data) {
        String safe = name == null || name.isEmpty() ? "file" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
        boolean picture = mime != null && mime.startsWith("image/");
        boolean video = mime != null && mime.startsWith("video/");
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = a.getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                Uri collection;
                if (picture) {
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + DIR);
                    collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                } else if (video) {
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/" + DIR);
                    collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                } else {
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + DIR);
                    collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                }
                Uri uri = cr.insert(collection, v);
                if (uri == null) throw new IllegalStateException("no uri");
                try (OutputStream out = cr.openOutputStream(uri)) {
                    if (out == null) throw new IllegalStateException("no stream");
                    out.write(data);
                }
            } else {
                if (a.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    a.requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE}, 7);
                    Toast.makeText(a, "Разрешите доступ к памяти и нажмите «Сохранить» ещё раз", Toast.LENGTH_LONG).show();
                    return;
                }
                File dir = new File(Environment.getExternalStoragePublicDirectory(
                        picture ? Environment.DIRECTORY_PICTURES : video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_DOWNLOADS), DIR);
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                File f = new File(dir, safe);
                try (FileOutputStream out = new FileOutputStream(f)) {
                    out.write(data);
                }
                a.sendBroadcast(new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(f)));
            }
            Toast.makeText(a, picture ? "Сохранено в Галерею" : "Сохранено в Загрузки", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(a, "Не получилось сохранить: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    static void share(Activity a, String name, String mime, byte[] data, String text) {
        try {
            File dir = new File(a.getCacheDir(), "share");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File f = new File(dir, name == null || name.isEmpty() ? "file" : name.replaceAll("[\\\\/:*?\"<>|]", "_"));
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(data);
            }
            Uri uri = FileProvider.getUriForFile(a, authority(a), f);
            Intent i = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (text != null && !text.isEmpty()) i.putExtra(Intent.EXTRA_TEXT, text);
            a.startActivity(Intent.createChooser(i, "Поделиться"));
        } catch (Exception e) {
            Toast.makeText(a, "Не получилось поделиться: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }
}
