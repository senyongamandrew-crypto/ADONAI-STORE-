package com.adonaithrift.pos;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.provider.Settings;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.graphics.Bitmap;
import android.util.Base64;
import android.os.Build;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintJob;
import android.print.PrintJobInfo;
import android.print.PrintManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.UUID;

/**
 * Adonai Store — native Android WebView shell (two apps, one shell).
 *
 * The web files are served through WebViewAssetLoader instead of file://. This
 * gives the app a normal HTTPS origin, keeps local assets available on-device,
 * and allows the app to make its authenticated requests to the live API.
 *
 * BuildConfig.DELIVERY_APP (ADONAI_APP_TARGET=delivery) makes this the
 * standalone Adonai Delivery rider app: it opens delivery.html, never the POS
 * register, and the POS-only bridge features (store alerts, exports, receipt
 * printing) stay off. The default build is the Adonai POS cashier terminal,
 * which also hosts the native rider GPS screen (rider.html).
 */
public class MainActivity extends AppCompatActivity {

    private static final String APP_ASSET_HOST = "appassets.androidplatform.net";
    private static final String POS_URL = "https://" + APP_ASSET_HOST + "/assets/public/pos.html";
    private static final int FILE_CHOOSER_REQUEST_CODE = 1001;
    private static final int CAMERA_REQUEST_CODE = 1002;
    private static final int EXPORT_SAVE_REQUEST_CODE = 1003;
    private static final int RIDER_PERMISSION_REQUEST_CODE = 1004;
    private static final int STORE_ALERT_PERMISSION_REQUEST_CODE = 1005;
    private static final int GEOLOCATION_PERMISSION_REQUEST_CODE = 1006;
    // Heads-up store alerts: new orders, customer messages and store changes.
    private static final String STORE_ALERT_CHANNEL = "store-alerts";
    private static final String STORE_ALERT_VIEW = "store_alert_view";
    private static final String RIDER_URL = "https://" + APP_ASSET_HOST + "/assets/public/rider.html";
    // The Adonai Delivery rider-partner app (delivery build's home screen).
    private static final String DELIVERY_URL = "https://" + APP_ASSET_HOST + "/assets/public/delivery.html";
    private static final long MAX_EXPORT_BYTES = 32L * 1024 * 1024;
    private static final String XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private WebViewAssetLoader assetLoader;
    private PermissionRequest pendingCameraRequest;
    private WebView tagPrintView;
    private PrintJob tagPrintJob;
    private WebView receiptPrintView;
    private PrintJob receiptPrintJob;
    private boolean receiptPrintPending = false;
    private volatile boolean trustedAppPage = false;
    private volatile boolean riderPageActive = false;
    private volatile boolean deliveryPageActive = false;
    private String pendingGeolocationOrigin;
    private GeolocationPermissions.Callback pendingGeolocationCallback;
    private final Object fileExportLock = new Object();
    private FileExport fileExport;
    private final ExecutorService riderWorker = Executors.newSingleThreadExecutor();
    private boolean riderStartPending = false;
    private volatile boolean activityResumed = false;

    private static final class FileExport {
        final String id, filename, mime;
        final File file;
        final long expected;
        FileOutputStream stream;
        long written = 0;
        boolean choosing = false, copying = false;
        volatile boolean cancelled = false;
        FileExport(String filename, String mime, long expected, File file) throws IOException {
            this.id = UUID.randomUUID().toString().replace("-", "");
            this.filename = filename; this.mime = mime; this.expected = expected;
            this.file = file; this.stream = new FileOutputStream(file);
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        // Clean private transfer staging left by an Android process kill.
        File[] staged = getCacheDir().listFiles((dir, name) -> name.startsWith("adonai-export-") && name.endsWith(".tmp"));
        if (staged != null) for (File file : staged) file.delete();

        webView = findViewById(R.id.posWebView);
        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        setupWebView();
        if (BuildConfig.DELIVERY_APP) {
            // Adonai Delivery is a standalone rider app: it always opens the
            // rider-partner screen and has no cashier register, store-alert
            // channel or admin deep links.
            webView.loadUrl(DELIVERY_URL);
            return;
        }
        createStoreAlertChannel();
        boolean riderMode = getIntent().getBooleanExtra("rider_mode", false) || RiderApi.prefs(this).getBoolean("rider_mode", false);
        String alertUrl = storeAlertUrl(getIntent());
        webView.loadUrl(riderMode ? RIDER_URL : (alertUrl != null ? alertUrl : POS_URL));
    }

    /* ------------------------------------------------------------------
       Store alerts (notification bell → Android notification shade)
       ------------------------------------------------------------------ */
    private void createStoreAlertChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel channel = new NotificationChannel(STORE_ALERT_CHANNEL, "Store alerts", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("New orders, customer messages and store changes from the notification bell.");
        channel.enableVibration(true);
        channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private String storeAlertPermissionState() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        boolean channelOn = Build.VERSION.SDK_INT < 26 || manager == null || manager.getNotificationChannel(STORE_ALERT_CHANNEL) == null
                || manager.getNotificationChannel(STORE_ALERT_CHANNEL).getImportance() != NotificationManager.IMPORTANCE_NONE;
        boolean runtime = Build.VERSION.SDK_INT < 33
                || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        if (runtime && channelOn && NotificationManagerCompat.from(this).areNotificationsEnabled()) return "granted";
        boolean asked = getSharedPreferences("adonai_store_alerts", MODE_PRIVATE).getBoolean("asked", false);
        if (Build.VERSION.SDK_INT >= 33 && !runtime && !asked) return "default";
        return "denied";
    }

    private void notifyStoreAlertPermission() {
        runOnUiThread(() -> {
            if (webView == null || !trustedAppPage || riderPageActive || deliveryPageActive || isFinishing()) return;
            webView.evaluateJavascript("window.__adonaiStoreAlertPermission && window.__adonaiStoreAlertPermission("
                    + JSONObject.quote(storeAlertPermissionState()) + ");", null);
        });
    }

    private void openStoreAlertSettingsScreen() {
        Intent settings;
        if (Build.VERSION.SDK_INT >= 26) {
            settings = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
        } else {
            settings = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
        }
        try { startActivity(settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
    }

    /** Admin workspace a tapped alert should open, or null for a normal launch. */
    @Nullable
    private String storeAlertUrl(@Nullable Intent intent) {
        if (intent == null) return null;
        String view = intent.getStringExtra(STORE_ALERT_VIEW);
        if (view == null) return null;
        if (view.isEmpty()) return POS_URL;
        if (!view.matches("[a-z]{1,20}")) return null;
        return "https://" + APP_ASSET_HOST + "/assets/public/admin.html?view=" + view;
    }

    private boolean postStoreAlert(String json) {
        try {
            JSONObject data = new JSONObject(json);
            String id = data.optString("id", "alert");
            if (!id.matches("[A-Za-z0-9_.:-]{1,80}")) return false;
            boolean foreground = data.optBoolean("foreground", false);
            // The bell already shows an in-app pop-up while the POS is on screen.
            if (activityResumed && !foreground) return false;
            if (!"granted".equals(storeAlertPermissionState())) return false;
            String title = data.optString("title", "Adonai Store");
            String body = data.optString("body", "");
            if (title.length() > 120) title = title.substring(0, 120);
            if (body.length() > 400) body = body.substring(0, 400);
            String view = data.optString("view", "");
            if (!view.matches("[a-z]{0,20}")) view = "";
            String type = data.optString("type", "");
            boolean urgent = data.optBoolean("urgent", false);

            Intent open = new Intent(this, MainActivity.class)
                    .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    .putExtra(STORE_ALERT_VIEW, view);
            PendingIntent tap = PendingIntent.getActivity(this, id.hashCode(), open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            // Lock screen shows only a neutral line; names and amounts stay private.
            android.app.Notification publicVersion = new NotificationCompat.Builder(this, STORE_ALERT_CHANNEL)
                    .setSmallIcon(android.R.drawable.ic_popup_reminder)
                    .setContentTitle("Adonai Store")
                    .setContentText("New store activity").build();
            NotificationCompat.Builder builder = new NotificationCompat.Builder(this, STORE_ALERT_CHANNEL)
                    .setSmallIcon("NEW_MESSAGE".equals(type) ? android.R.drawable.stat_notify_chat : android.R.drawable.ic_popup_reminder)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                    .setPriority(urgent ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
                    .setCategory("NEW_MESSAGE".equals(type) ? NotificationCompat.CATEGORY_MESSAGE : NotificationCompat.CATEGORY_EVENT)
                    .setDefaults(NotificationCompat.DEFAULT_ALL)
                    .setAutoCancel(true)
                    .setContentIntent(tap)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setPublicVersion(publicVersion)
                    .setWhen(System.currentTimeMillis())
                    .setShowWhen(true);
            NotificationManagerCompat.from(this).notify("store-alert", id.hashCode(), builder.build());
            return true;
        } catch (SecurityException e) {
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        // Render at true device scale regardless of the phone's system font-size /
        // display settings — the register is a fixed terminal UI that must always
        // fit the screen instead of appearing zoomed in.
        settings.setTextZoom(100);

        webView.addJavascriptInterface(new AndroidBridge(), "Android");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                trustedAppPage = isTrustedAppUri(Uri.parse(url));
                riderPageActive = trustedAppPage && RIDER_URL.equals(url);
                deliveryPageActive = trustedAppPage && isDeliveryPageUrl(url);
                if (!riderPageActive) riderStartPending = false;
                if (!trustedAppPage) { cancelCurrentFileExport(); cancelReceiptDocument(); }
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @SuppressWarnings("deprecation")
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return assetLoader.shouldInterceptRequest(Uri.parse(url));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrlNavigation(request.getUrl().toString());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrlNavigation(url);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                // The Adonai Delivery page's GPS duty switch uses the web
                // Geolocation API (watchPosition). Without this prompt the
                // WebView silently denies every fix, so a delivery APK would
                // start a duty that never reports a position. Only the bundled
                // app origin may ask, and only after the rider grants the
                // Android Location runtime permission. Not retained: the duty
                // consent in the page gates every duty, not this prompt.
                runOnUiThread(() -> {
                    Uri originUri = origin == null ? null : Uri.parse(origin);
                    if (!isTrustedAppUri(originUri) || isFinishing()) {
                        callback.invoke(origin, false, false);
                        return;
                    }
                    if (hasLocationPermission()) {
                        callback.invoke(origin, true, false);
                        return;
                    }
                    if (pendingGeolocationCallback != null) {
                        pendingGeolocationCallback.invoke(pendingGeolocationOrigin, false, false);
                    }
                    pendingGeolocationOrigin = origin;
                    pendingGeolocationCallback = callback;
                    ActivityCompat.requestPermissions(MainActivity.this,
                            new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION},
                            GEOLOCATION_PERMISSION_REQUEST_CODE);
                });
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    // Camera only, for bundled app pages. Never grant microphone,
                    // arbitrary resource requests, or an untrusted web origin.
                    String[] resources = request.getResources();
                    if (!isTrustedAppUri(request.getOrigin()) || resources.length != 1
                            || !PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resources[0])) {
                        request.deny();
                        return;
                    }
                    if (pendingCameraRequest != null) pendingCameraRequest.deny();
                    pendingCameraRequest = request;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                            && ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA)
                            != PackageManager.PERMISSION_GRANTED) {
                        ActivityCompat.requestPermissions(MainActivity.this,
                                new String[]{Manifest.permission.CAMERA}, CAMERA_REQUEST_CODE);
                    } else {
                        grantPendingCamera();
                    }
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingCameraRequest == request) pendingCameraRequest = null;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                              FileChooserParams fileChooserParams) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;

                Intent intent = fileChooserParams.createIntent();
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                        fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST_CODE);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });
    }

    private boolean isTrustedAppUri(Uri uri) {
        return uri != null && "https".equalsIgnoreCase(uri.getScheme())
                && APP_ASSET_HOST.equalsIgnoreCase(uri.getHost());
    }

    /** The rider-partner page, with or without its #jobs/#active tab hash. */
    private boolean isDeliveryPageUrl(String url) {
        return url != null && (url.equals(DELIVERY_URL) || url.startsWith(DELIVERY_URL + "#")
                || url.startsWith(DELIVERY_URL + "?"));
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void grantPendingCamera() {
        PermissionRequest request = pendingCameraRequest;
        pendingCameraRequest = null;
        if (request != null) {
            if (isTrustedAppUri(request.getOrigin())) {
                request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else request.deny();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == RIDER_PERMISSION_REQUEST_CODE) {
            if (!hasRiderPermissions()) {
                riderStartPending = false;
                RiderApi.status(this,"error","Allow Location and notifications to start visible duty tracking. Approximate location may be less accurate.");
            } else maybeStartRiderService();
        }
        if (requestCode == STORE_ALERT_PERMISSION_REQUEST_CODE) notifyStoreAlertPermission();
        if (requestCode == CAMERA_REQUEST_CODE && pendingCameraRequest != null) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                grantPendingCamera();
            } else {
                pendingCameraRequest.deny();
                pendingCameraRequest = null;
            }
        }
        if (requestCode == GEOLOCATION_PERMISSION_REQUEST_CODE && pendingGeolocationCallback != null) {
            GeolocationPermissions.Callback callback = pendingGeolocationCallback;
            String origin = pendingGeolocationOrigin;
            pendingGeolocationCallback = null;
            pendingGeolocationOrigin = null;
            callback.invoke(origin, hasLocationPermission(), false);
        }
    }

    private boolean trustedRiderPage() {
        return trustedAppPage && riderPageActive; // JS bridge calls run off the WebView/UI thread.
    }

    private void riderResult(String id, JSONObject data) {
        runOnUiThread(() -> {
            if (!trustedRiderPage() || isFinishing()) return;
            webView.evaluateJavascript("window.__adonaiRiderResult && window.__adonaiRiderResult("
                    + JSONObject.quote(id) + "," + JSONObject.quote(data.toString()) + ");", null);
        });
    }

    private void riderError(String id, String message) {
        try { riderResult(id,new JSONObject().put("ok",false).put("error",message)); } catch (Exception ignored) {}
    }

    private boolean hasRiderPermissions() {
        boolean location = ContextCompat.checkSelfPermission(this,Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(this,Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED;
        NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        boolean channelVisible=Build.VERSION.SDK_INT<26 || manager.getNotificationChannel("rider-location")==null
                || manager.getNotificationChannel("rider-location").getImportance()!=NotificationManager.IMPORTANCE_NONE;
        return location && channelVisible && (Build.VERSION.SDK_INT<33 || ContextCompat.checkSelfPermission(this,Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED)
                && NotificationManagerCompat.from(this).areNotificationsEnabled();
    }

    private void maybeStartRiderService() {
        if (!riderStartPending || !activityResumed || !trustedRiderPage() || !hasRiderPermissions()) return;
        riderStartPending = false;
        if (RiderApi.prefs(this).getString("token", "").isEmpty()) { RiderApi.status(this,"error","Pair this phone before starting duty."); return; }
        try { ContextCompat.startForegroundService(this,new Intent(this,RiderTrackingService.class).setAction(RiderTrackingService.START)); }
        catch (Exception e) { RiderApi.status(this,"error","Could not start visible tracking. Reopen the rider app and check phone permissions."); }
    }

    @Override protected void onResume() { super.onResume(); activityResumed=true; maybeStartRiderService(); notifyStoreAlertPermission(); }
    @Override protected void onPause() { activityResumed=false; super.onPause(); }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        if (BuildConfig.DELIVERY_APP) {
            // The delivery bundle has no rider.html/POS pages to deep-link to.
            if (webView!=null && !deliveryPageActive) webView.loadUrl(DELIVERY_URL);
            return;
        }
        if (intent.getBooleanExtra("rider_mode",false) && webView!=null) webView.loadUrl(RIDER_URL);
        else if (webView!=null && !RiderApi.prefs(this).getBoolean("rider_mode",false)) {
            String alertUrl = storeAlertUrl(intent);
            if (alertUrl != null) webView.loadUrl(alertUrl);
        }
    }

    private boolean handleUrlNavigation(String url) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        String host = uri.getHost();

        // Keep app pages inside the POS WebView. In particular, do not send
        // appassets URLs or links such as admin.html to the external browser.
        if ("https".equalsIgnoreCase(scheme) && APP_ASSET_HOST.equalsIgnoreCase(host)) {
            return false;
        }

        if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)
                || "tel".equalsIgnoreCase(scheme)
                || "mailto".equalsIgnoreCase(scheme)
                || "whatsapp".equalsIgnoreCase(scheme)) {
            openExternalUrl(uri);
            return true;
        }
        return false;
    }

    private void openExternalUrl(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            startActivity(intent);
        } catch (Exception ignored) {
            // There is no browser/handler installed for this URI. Leave the
            // WebView unchanged rather than crashing the POS terminal.
        }
    }

    /** App-private transfer staging; no public path, storage permission or URL credentials. */
    private void cleanupFileExport(FileExport item) {
        synchronized (fileExportLock) {
            if (item.stream != null) { try { item.stream.close(); } catch (IOException ignored) {} item.stream = null; }
            item.file.delete();
            if (fileExport == item) fileExport = null;
        }
    }

    private void exportResult(FileExport item, String status, String message) {
        cleanupFileExport(item);
        runOnUiThread(() -> {
            if (webView == null || !trustedAppPage || isFinishing()) return;
            webView.evaluateJavascript("window.__adonaiFileExportResult && window.__adonaiFileExportResult("
                    + JSONObject.quote(item.id) + "," + JSONObject.quote(status) + "," + JSONObject.quote(message) + ");", null);
        });
    }

    private void cancelCurrentFileExport() {
        synchronized (fileExportLock) {
            FileExport item = fileExport;
            if (item == null) return;
            item.cancelled = true;
            if (item.choosing) runOnUiThread(() -> finishActivity(EXPORT_SAVE_REQUEST_CODE));
            else if (!item.copying) cleanupFileExport(item);
        }
    }

    private void openExportSaveDialog(FileExport item) {
        if (!trustedAppPage || isFinishing() || item.cancelled) {
            exportResult(item, "cancelled", "Save cancelled. Export the report again when ready."); return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(item.mime);
        intent.putExtra(Intent.EXTRA_TITLE, item.filename);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try { startActivityForResult(intent, EXPORT_SAVE_REQUEST_CODE); }
        catch (Exception e) { exportResult(item, "error", "Save As could not be opened. Open this report in your phone browser instead."); }
    }

    private void completeExportSave(int resultCode, Intent data) {
        final FileExport item;
        synchronized (fileExportLock) {
            item = fileExport;
            if (item == null || !item.choosing) return;
            item.choosing = false;
            if (item.cancelled || resultCode != RESULT_OK || data == null || data.getData() == null) {
                exportResult(item, "cancelled", "Save cancelled — tap Download again to choose a folder."); return;
            }
            item.copying = true;
        }
        final Uri destination = data.getData();
        // Write on a worker, not the WebView/UI thread. Only the URI selected by
        // Android's document picker is used; JavaScript cannot choose a path.
        new Thread(() -> {
            try {
                if (!"content".equalsIgnoreCase(destination.getScheme())) throw new IOException("Invalid destination");
                long copied = 0;
                try (FileInputStream source = new FileInputStream(item.file);
                     OutputStream target = getContentResolver().openOutputStream(destination, "wt")) {
                    if (target == null) throw new IOException("Folder unavailable");
                    byte[] buffer = new byte[16384]; int length;
                    while ((length = source.read(buffer)) != -1) {
                        if (item.cancelled || !trustedAppPage) throw new IOException("Save cancelled");
                        target.write(buffer, 0, length); copied += length;
                    }
                    target.flush();
                }
                if (copied != item.expected || item.cancelled) throw new IOException("Incomplete file");
                exportResult(item, "saved", "Saved " + item.filename + ". Open it from the folder you chose in Save As.");
            } catch (Exception e) {
                exportResult(item, item.cancelled ? "cancelled" : "error", item.cancelled
                        ? "Save cancelled. Export again when the area is unlocked."
                        : "The file could not be fully saved. Check free space and choose a writable folder, then tap Download again.");
            }
        }, "AdonaiFileExport").start();
    }

    private boolean activePrintJob(PrintJob job) {
        return job != null && (job.isQueued() || job.isStarted() || job.isBlocked()
                || job.getInfo().getState() == PrintJobInfo.STATE_CREATED);
    }

    private void receiptPrintResult(String status, String message) {
        runOnUiThread(() -> {
            if (webView == null || !trustedAppPage || isFinishing()) return;
            webView.evaluateJavascript("window.__adonaiReceiptPrintResult && window.__adonaiReceiptPrintResult("
                    + JSONObject.quote(status) + "," + JSONObject.quote(message) + ");", null);
        });
    }

    private void cancelReceiptDocument() {
        runOnUiThread(() -> {
            if (activePrintJob(receiptPrintJob)) receiptPrintJob.cancel();
            receiptPrintJob = null; receiptPrintPending = false;
            if (receiptPrintView != null) { receiptPrintView.destroy(); receiptPrintView = null; }
        });
    }

    private void printReceiptDocument(String html, String title, String paper) {
        if (!trustedAppPage || isFinishing() || webView == null
                || webView.getUrl() == null || !isTrustedAppUri(Uri.parse(webView.getUrl()))) return;
        if (receiptPrintPending || activePrintJob(receiptPrintJob) || activePrintJob(tagPrintJob)) {
            receiptPrintResult("error", "Finish the current print job, then tap the invoice again."); return;
        }
        if (receiptPrintView != null) receiptPrintView.destroy();
        receiptPrintPending = true;
        receiptPrintView = new WebView(MainActivity.this);
        // A document, never another app window: no scripts, bridge, files,
        // content URIs or network loads. All layout/text is self-contained.
        receiptPrintView.getSettings().setJavaScriptEnabled(false);
        receiptPrintView.getSettings().setAllowFileAccess(false);
        receiptPrintView.getSettings().setAllowContentAccess(false);
        receiptPrintView.getSettings().setBlockNetworkLoads(true);
        receiptPrintView.setWebViewClient(new WebViewClient() {
            private boolean submitted = false;
            @Override
            public void onPageFinished(WebView view, String url) {
                if (submitted || isFinishing() || !trustedAppPage || view != receiptPrintView) return;
                submitted = true; receiptPrintPending = false;
                PrintManager manager = (PrintManager) getSystemService(PRINT_SERVICE);
                if (manager == null) { receiptPrintResult("error", "Android printing is unavailable. Use the browser or print your Excel export."); return; }
                PrintAttributes.MediaSize size = "receipt".equals(paper)
                        ? new PrintAttributes.MediaSize("ADONAI_RECEIPT_80", "80 mm receipt", 3150, 11693)
                        : PrintAttributes.MediaSize.ISO_A4;
                PrintAttributes attributes = new PrintAttributes.Builder().setMediaSize(size)
                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                        .setColorMode(PrintAttributes.COLOR_MODE_MONOCHROME).build();
                try {
                    receiptPrintJob = manager.print(title, view.createPrintDocumentAdapter(title), attributes);
                    receiptPrintResult("ready", "System print opened. Choose a printer or Save as PDF; your saved invoices stay unchanged.");
                } catch (Exception e) { receiptPrintResult("error", "Printing could not open. Try the phone browser or your Excel export."); }
            }
        });
        receiptPrintView.loadDataWithBaseURL("https://" + APP_ASSET_HOST + "/", html, "text/html", "UTF-8", null);
    }

    private class AndroidBridge {
        @JavascriptInterface
        public String riderTrackingState() {
            if (!trustedRiderPage()) return "{}";
            try { return RiderApi.state(MainActivity.this).toString(); } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface
        public boolean pairRiderPhone(String id, String base, String code, String label) {
            if (!trustedRiderPage() || id==null || !id.matches("[A-Za-z0-9_-]{1,60}") || !RiderApi.validBase(base)
                    || code==null || code.length()>20 || label==null || label.length()>100) return false;
            if (RiderTrackingService.active) { riderError(id,"Stop GPS sharing before pairing another rider."); return false; }
            riderWorker.execute(() -> {
                try {
                    JSONObject answer=RiderApi.request(base,"","POST","/api/rider/pair",new JSONObject().put("code",code).put("device_label",label));
                    String token=answer.getString("session_token");
                    if (!token.matches("[A-Za-z0-9_-]{43}")) throw new Exception("Invalid session");
                    RiderApi.prefs(MainActivity.this).edit().putString("token",token).putString("base",base.replaceAll("/$",""))
                            .putString("rider_name",answer.getJSONObject("rider").getString("name"))
                            .putBoolean("rider_mode",true).putBoolean("pending_stop",false).putInt("sequence",0).putLong("last_upload_ms",0).commit();
                    RiderApi.status(MainActivity.this,"stopped","Phone paired. GPS is off until you explicitly start duty.");
                    answer.remove("session_token"); riderResult(id,answer);
                } catch (RiderApi.ApiError e) { riderError(id,e.getMessage()); }
                catch (Exception e) { riderError(id,"Pairing failed. Check the store HTTPS address, connection and code."); }
            }); return true;
        }

        @JavascriptInterface
        public boolean riderCommand(String id, String command, String payload) {
            if (!trustedRiderPage() || id==null || !id.matches("[A-Za-z0-9_-]{1,60}") || payload==null || payload.length()>2048
                    || (!"me".equals(command) && !"progress".equals(command))) return false;
            riderWorker.execute(() -> {
                try {
                    if (!RiderTrackingService.active && RiderApi.prefs(MainActivity.this).getBoolean("pending_stop",false)) {
                        RiderApi.pairedRequest(MainActivity.this,"POST","/api/rider/duty/stop",new JSONObject());
                        RiderApi.prefs(MainActivity.this).edit().putBoolean("pending_stop",false).apply();
                    }
                    JSONObject body=new JSONObject(payload);
                    String path="/api/rider/me",method="GET";
                    if ("progress".equals(command)) {
                        String order=body.optString("order_id","");
                        if (!order.matches("[A-Za-z0-9_-]{1,50}")) throw new Exception("Invalid order");
                        path="/api/rider/orders/"+order+"/progress";method="POST";body.remove("order_id");
                    }
                    riderResult(id,RiderApi.pairedRequest(MainActivity.this,method,path,"GET".equals(method)?null:body));
                } catch (RiderApi.ApiError e) {
                    if (e.status==401) { stopService(new Intent(MainActivity.this,RiderTrackingService.class)); RiderApi.prefs(MainActivity.this).edit().remove("token").apply(); RiderApi.status(MainActivity.this,"error","Pairing expired/revoked. Pair this phone again."); }
                    riderError(id,e.getMessage());
                } catch (Exception e) { riderError(id,"Could not reach dispatch. Check connection and try again."); }
            });return true;
        }

        @JavascriptInterface
        public void startRiderTracking() {
            if (!trustedRiderPage()) return;
            runOnUiThread(() -> {
                if (!trustedRiderPage() || !activityResumed || RiderTrackingService.active || isFinishing()) return;
                if (RiderApi.prefs(MainActivity.this).getString("token","").isEmpty()) { RiderApi.status(MainActivity.this,"error","Pair this phone first."); return; }
                String host=Uri.parse(RiderApi.prefs(MainActivity.this).getString("base","")).getHost();
                new AlertDialog.Builder(MainActivity.this).setTitle("Start delivery GPS sharing?")
                        .setMessage("Your latest GPS position and accuracy will be shared with dispatch at " + host
                                + " for this duty, up to 12 hours, including while the screen is locked. An ongoing notification has Stop sharing. No phone serial or route history is collected.")
                        .setNegativeButton("Not now",(dialog,which)->{})
                        .setPositiveButton("Start sharing",(dialog,which)->{
                            if (!trustedRiderPage() || !activityResumed) return;
                            riderStartPending=true;
                            ArrayList<String> permissions=new ArrayList<>();
                            if (Build.VERSION.SDK_INT>=23 && ContextCompat.checkSelfPermission(MainActivity.this,Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED) {
                                permissions.add(Manifest.permission.ACCESS_FINE_LOCATION);permissions.add(Manifest.permission.ACCESS_COARSE_LOCATION);
                            }
                            if (Build.VERSION.SDK_INT>=33 && ContextCompat.checkSelfPermission(MainActivity.this,Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED) permissions.add(Manifest.permission.POST_NOTIFICATIONS);
                            if (!permissions.isEmpty()) ActivityCompat.requestPermissions(MainActivity.this,permissions.toArray(new String[0]),RIDER_PERMISSION_REQUEST_CODE);
                            else if (!hasRiderPermissions()) {riderStartPending=false;RiderApi.status(MainActivity.this,"error","Enable notifications in phone Settings to keep the tracking Stop action visible.");}
                            else maybeStartRiderService();
                        }).show();
            });
        }

        @JavascriptInterface
        public void stopRiderTracking() {
            if (!trustedRiderPage()) return;
            runOnUiThread(() -> {
                if (!trustedRiderPage() || !activityResumed || isFinishing()) return;
                riderStartPending=false;
                startService(new Intent(MainActivity.this,RiderTrackingService.class).setAction(RiderTrackingService.STOP));
            });
        }

        @JavascriptInterface
        public boolean printReceipts(String html, String title, String paper) {
            if (!trustedAppPage || deliveryPageActive || html == null || html.length() > 1024 * 1024
                    || title == null || title.length() > 180
                    || (!"a4".equals(paper) && !"receipt".equals(paper))) return false;
            runOnUiThread(() -> printReceiptDocument(html, title, paper));
            return true;
        }

        @JavascriptInterface
        public void cancelReceiptPrint() {
            if (trustedAppPage) cancelReceiptDocument();
        }

        @JavascriptInterface
        public String beginFileExport(String filename, String mime, long expectedBytes) {
            if (!trustedAppPage || deliveryPageActive || filename == null || mime == null || expectedBytes < 1 || expectedBytes > MAX_EXPORT_BYTES) return "";
            String cleanName = filename.replaceAll("[^A-Za-z0-9 ._-]", "_");
            if (cleanName.length() > 180) cleanName = cleanName.substring(0, 180);
            if (!("text/csv".equals(mime) && cleanName.endsWith(".csv"))
                    && !(XLSX_MIME.equals(mime) && cleanName.endsWith(".xlsx"))) return "";
            synchronized (fileExportLock) {
                if (fileExport != null) return "";
                File temporary = null;
                try {
                    temporary = File.createTempFile("adonai-export-", ".tmp", getCacheDir());
                    fileExport = new FileExport(cleanName, mime, expectedBytes, temporary);
                    return fileExport.id;
                } catch (IOException e) { if (temporary != null) temporary.delete(); return ""; }
            }
        }

        @JavascriptInterface
        public boolean appendFileExport(String id, String encodedChunk) {
            if (!trustedAppPage || encodedChunk == null || encodedChunk.length() > 180000) return false;
            synchronized (fileExportLock) {
                FileExport item = fileExport;
                if (item == null || !item.id.equals(id) || item.cancelled || item.choosing || item.copying || item.stream == null) return false;
                try {
                    byte[] bytes = Base64.decode(encodedChunk, Base64.NO_WRAP);
                    if (bytes.length > 128 * 1024 || item.written + bytes.length > item.expected) return false;
                    item.stream.write(bytes); item.written += bytes.length; return true;
                } catch (Exception e) { return false; }
            }
        }

        @JavascriptInterface
        public boolean finishFileExport(String id) {
            if (!trustedAppPage) return false;
            synchronized (fileExportLock) {
                FileExport item = fileExport;
                if (item == null || !item.id.equals(id) || item.cancelled || item.choosing || item.copying
                        || item.written != item.expected || item.stream == null) return false;
                try { item.stream.close(); item.stream = null; }
                catch (IOException e) { cleanupFileExport(item); return false; }
                item.choosing = true;
                runOnUiThread(() -> openExportSaveDialog(item));
                return true;
            }
        }

        @JavascriptInterface
        public void cancelFileExport(String id) {
            if (!trustedAppPage) return;
            synchronized (fileExportLock) { if (fileExport != null && fileExport.id.equals(id)) cancelCurrentFileExport(); }
        }

        @JavascriptInterface
        public void printTags(String html, String paper) {
            if (deliveryPageActive || html == null || html.length() > 1024 * 1024) return;
            if (!"a4".equals(paper) && !"label".equals(paper) && !"compact".equals(paper)) return;
            runOnUiThread(() -> {
                if (webView == null || webView.getUrl() == null || !isTrustedAppUri(Uri.parse(webView.getUrl()))) return;
                if (receiptPrintPending || activePrintJob(receiptPrintJob)) return;
                if (tagPrintJob != null && (tagPrintJob.isQueued() || tagPrintJob.isStarted()
                        || tagPrintJob.isBlocked() || tagPrintJob.getInfo().getState() == PrintJobInfo.STATE_CREATED)) return;
                if (tagPrintView != null) tagPrintView.destroy();
                tagPrintView = new WebView(MainActivity.this);
                // The print document has no bridge, scripts, files or network access.
                tagPrintView.getSettings().setJavaScriptEnabled(false);
                tagPrintView.getSettings().setAllowFileAccess(false);
                tagPrintView.getSettings().setAllowContentAccess(false);
                tagPrintView.getSettings().setBlockNetworkLoads(true);
                tagPrintView.setWebViewClient(new WebViewClient() {
                    private boolean submitted = false;
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        if (submitted || isFinishing()) return;
                        submitted = true;
                        PrintManager manager = (PrintManager) getSystemService(PRINT_SERVICE);
                        if (manager == null) return;
                        PrintAttributes.MediaSize size = "a4".equals(paper)
                                ? PrintAttributes.MediaSize.ISO_A4
                                : ("compact".equals(paper)
                                ? new PrintAttributes.MediaSize("ADONAI_62_40", "62 × 40 mm tag", 2441, 1575)
                                : new PrintAttributes.MediaSize("ADONAI_80_50", "80 × 50 mm tag", 3150, 1969));
                        PrintAttributes attributes = new PrintAttributes.Builder()
                                .setMediaSize(size)
                                .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                                .setColorMode(PrintAttributes.COLOR_MODE_MONOCHROME)
                                .build();
                        tagPrintJob = manager.print("Adonai garment tags",
                                view.createPrintDocumentAdapter("Adonai garment tags"), attributes);
                    }
                });
                tagPrintView.loadDataWithBaseURL("https://" + APP_ASSET_HOST + "/",
                        html, "text/html", "UTF-8", null);
            });
        }

        /* Store alerts for the POS / Admin pages (never the rider or delivery pages). */
        @JavascriptInterface
        public String storeAlertPermission() {
            if (!trustedAppPage || riderPageActive || deliveryPageActive) return "denied";
            return storeAlertPermissionState();
        }

        @JavascriptInterface
        public void requestStoreAlertPermission() {
            if (!trustedAppPage || riderPageActive || deliveryPageActive) return;
            runOnUiThread(() -> {
                if (isFinishing()) return;
                if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                        && !getSharedPreferences("adonai_store_alerts", MODE_PRIVATE).getBoolean("asked", false)) {
                    getSharedPreferences("adonai_store_alerts", MODE_PRIVATE).edit().putBoolean("asked", true).apply();
                    ActivityCompat.requestPermissions(MainActivity.this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, STORE_ALERT_PERMISSION_REQUEST_CODE);
                } else if (!"granted".equals(storeAlertPermissionState())) {
                    openStoreAlertSettingsScreen();
                } else notifyStoreAlertPermission();
            });
        }

        @JavascriptInterface
        public void openStoreAlertSettings() {
            if (!trustedAppPage || riderPageActive || deliveryPageActive) return;
            runOnUiThread(MainActivity.this::openStoreAlertSettingsScreen);
        }

        @JavascriptInterface
        public boolean storeAppVisible() {
            return activityResumed;
        }

        @JavascriptInterface
        public boolean showStoreAlert(String json) {
            if (!trustedAppPage || riderPageActive || deliveryPageActive || json == null || json.length() > 4096) return false;
            return postStoreAlert(json);
        }

        @JavascriptInterface
        public void openExternal(String url) {
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return;
            runOnUiThread(() -> openExternalUrl(uri));
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        if (requestCode == EXPORT_SAVE_REQUEST_CODE) {
            completeExportSave(resultCode, data);
        } else if (requestCode == FILE_CHOOSER_REQUEST_CODE && filePathCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                } else if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        trustedAppPage = false;
        synchronized (fileExportLock) {
            if (fileExport != null) { fileExport.cancelled = true; cleanupFileExport(fileExport); }
        }
        if (pendingCameraRequest != null) {
            pendingCameraRequest.deny();
            pendingCameraRequest = null;
        }
        if (tagPrintView != null) { tagPrintView.destroy(); tagPrintView = null; }
        if (activePrintJob(receiptPrintJob)) receiptPrintJob.cancel();
        if (receiptPrintView != null) { receiptPrintView.destroy(); receiptPrintView = null; }
        if (webView != null) { webView.destroy(); webView = null; }
        riderWorker.shutdown();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
