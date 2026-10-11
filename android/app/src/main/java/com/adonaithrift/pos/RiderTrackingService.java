package com.adonaithrift.pos;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationManagerCompat;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;

/** Visible, explicit-duty foreground GPS. No boot receiver, serial or IMEI.
 * Continues independently of the WebView while the screen is locked. Force-stop,
 * OEM battery controls, no network and revoked GPS can still interrupt updates.
 */
public class RiderTrackingService extends Service implements LocationListener {
    static volatile boolean active = false;
    static final String START = "com.adonaithrift.pos.RIDER_START";
    static final String STOP = "com.adonaithrift.pos.RIDER_STOP";
    private static final String CHANNEL = "rider-location";
    private static final int NOTIFICATION_ID = 4201;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean uploadScheduled = new AtomicBoolean(false);
    private LocationManager locationManager;
    private volatile Location latest;
    private volatile boolean stopping = false;
    private boolean started = false;
    private volatile long dutyUntil = 0, elapsedDutyUntil = 0;
    private long lastAttempt = 0;
    private final Runnable dutyTimeout = () -> stopSharing("Duty ended after 12 hours. Start a new duty explicitly.");
    private final Runnable retry = () -> {
        if (!stopping && dutyExpired()) { stopSharing("Duty ended. Start a new duty explicitly."); return; }
        if (!stopping && !visiblePermission()) { stopSharing("Location/notification permission was disabled. Sharing stopped."); return; }
        if (!stopping && latest != null && System.currentTimeMillis() - latest.getTime() <= 90000) enqueueUpload();
        if (!stopping) handler.postDelayed(this.retry, 20000);
    };

    @Override public void onCreate() {
        super.onCreate();
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Delivery GPS sharing", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Visible duty tracking with a Stop sharing action. Not marketing notifications.");
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(channel);
        }
        // A killed process does not restart duty automatically or claim to be live.
        RiderApi.prefs(this).edit().putBoolean("running", false).apply();
    }
    private Notification notification(String message) {
        Intent open = new Intent(this, MainActivity.class).putExtra("rider_mode", true);
        PendingIntent tap = PendingIntent.getActivity(this, 4202, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, RiderTrackingService.class).setAction(STOP);
        PendingIntent action = PendingIntent.getService(this, 4203, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle("Adonai delivery GPS sharing").setContentText(message)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(message)).setContentIntent(tap)
                .setOngoing(true).setOnlyAlertOnce(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .addAction(android.R.drawable.ic_media_pause, "Stop sharing", action).build();
    }
    private void update(String state, String message) {
        RiderApi.status(this, state, message);
        if (!stopping) ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID, notification(message));
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || !START.equals(intent.getAction())) {
            stopSharing("GPS sharing stopped on this phone."); return START_NOT_STICKY;
        }
        if (started) return START_NOT_STICKY;
        started = true; stopping = false; active = true;
        Notification visible = notification("Connecting to dispatch — location not yet shared.");
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, visible, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(NOTIFICATION_ID, visible);
        } catch (Exception e) { RiderApi.status(this, "error", "Could not start visible tracking. Check location/notification permission and reopen the rider app."); stopSelf(); return START_NOT_STICKY; }
        RiderApi.prefs(this).edit().putBoolean("running", true).putLong("last_upload_ms", 0).apply();
        worker.execute(() -> {
            try {
                // Complete a previously failed stop before starting another duty.
                if (RiderApi.prefs(this).getBoolean("pending_stop", false)) {
                    RiderApi.pairedRequest(this, "POST", "/api/rider/duty/stop", new JSONObject());
                    RiderApi.prefs(this).edit().putBoolean("pending_stop", false).apply();
                }
                JSONObject answer = RiderApi.pairedRequest(this, "POST", "/api/rider/duty/start", new JSONObject().put("consent", true));
                SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
                format.setTimeZone(TimeZone.getTimeZone("UTC"));
                dutyUntil = format.parse(answer.getString("duty_until")).getTime();
                // elapsedRealtime includes deep sleep and cannot be extended by changing the wall clock.
                elapsedDutyUntil = SystemClock.elapsedRealtime() + 12L * 60L * 60L * 1000L;
                handler.post(() -> {
                    if (stopping) return;
                    handler.postDelayed(dutyTimeout, Math.max(1, dutyUntil - System.currentTimeMillis()));
                    requestLocations(); handler.postDelayed(retry, 20000);
                });
            } catch (Exception e) { handler.post(() -> stopSharing("Could not start duty. Check connection/pairing and tap Start again.")); }
        });
        return START_NOT_STICKY;
    }
    private boolean dutyExpired() {
        return dutyUntil>0 && (System.currentTimeMillis()>=dutyUntil || SystemClock.elapsedRealtime()>=elapsedDutyUntil);
    }
    private boolean visiblePermission() {
        NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        boolean location=ContextCompat.checkSelfPermission(this,Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(this,Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED;
        boolean notification=NotificationManagerCompat.from(this).areNotificationsEnabled()
                && (Build.VERSION.SDK_INT<26 || manager.getNotificationChannel(CHANNEL)==null
                    || manager.getNotificationChannel(CHANNEL).getImportance()!=NotificationManager.IMPORTANCE_NONE);
        return location && notification;
    }

    private void requestLocations() {
        boolean fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if ((!fine && !coarse) || locationManager == null) { stopSharing("Location permission was revoked. Reopen the rider app."); return; }
        boolean requested = false;
        try {
            if (fine && locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 20000, 0f, this, Looper.getMainLooper()); requested = true;
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 20000, 0f, this, Looper.getMainLooper()); requested = true;
            }
            // Do not upload cached last-known fixes as if they were current GPS.
            update("waiting", requested ? "Duty active. Waiting for a fresh GPS fix; Stop sharing is always available." : "Location is off. Enable phone Location or stop sharing. Dispatch has no fresh fix.");
        } catch (SecurityException e) { stopSharing("Location permission was revoked. Reopen the rider app."); }
    }
    @Override public void onLocationChanged(Location location) {
        if (!stopping && dutyExpired()) { stopSharing("Duty ended. Start a new duty explicitly."); return; }
        if (!stopping && !visiblePermission()) { stopSharing("Location/notification permission was disabled. Sharing stopped."); return; }
        if (stopping || location == null || !location.hasAccuracy() || System.currentTimeMillis() - location.getTime() > 90000) return;
        Location previous = latest;
        // A newer coarse network fix should not displace a recent, much better GPS fix.
        if (previous != null && location.getTime() < previous.getTime()) return;
        if (previous != null && location.getTime() - previous.getTime() < 15000 && location.getAccuracy() > previous.getAccuracy() * 2) return;
        latest = new Location(location); enqueueUpload();
    }
    private void enqueueUpload() {
        if (stopping || System.currentTimeMillis() - lastAttempt < 15000 || !uploadScheduled.compareAndSet(false, true)) return;
        lastAttempt = System.currentTimeMillis();
        worker.execute(() -> {
            PowerManager.WakeLock wake = null;
            try {
                if (stopping || latest == null) return;
                Location point = new Location(latest);
                if (dutyExpired()) { handler.post(() -> stopSharing("Duty ended. Start a new duty explicitly.")); return; }
                if (System.currentTimeMillis() - point.getTime() > 90000) return;
                PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
                wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Adonai:RiderUpload"); wake.acquire(20000);
                SharedPreferences preferences = RiderApi.prefs(this);
                int sequence = preferences.getInt("sequence", 0) + 1;
                if (sequence >= 2147483646) { handler.post(() -> stopSharing("Pair this phone again to reset the delivery session.")); return; }
                preferences.edit().putInt("sequence", sequence).apply();
                JSONObject payload = new JSONObject().put("latitude", point.getLatitude()).put("longitude", point.getLongitude())
                        .put("accuracy_m", point.getAccuracy()).put("fix_time_ms", point.getTime()).put("sequence", sequence)
                        .put("mock", point.isFromMockProvider());
                JSONObject answer = RiderApi.pairedRequest(this, "POST", "/api/rider/location", payload);
                if (answer.optBoolean("ignored",false)) {
                    handler.post(() -> { if (!stopping) update("waiting","Older GPS fix ignored by dispatch. Waiting for a newer fix; no fresh upload claimed."); });
                    return;
                }
                if (!stopping) {
                    preferences.edit().putLong("last_upload_ms", System.currentTimeMillis()).apply();
                    handler.post(() -> { if (!stopping) update("sharing", "GPS sent to dispatch. Approx. ±" + Math.round(point.getAccuracy()) + " m. Tap Stop sharing to finish duty."); });
                }
            } catch (RiderApi.ApiError e) {
                if (e.status == 401 || e.status == 403 || e.status == 409 || e.status == 404) handler.post(() -> stopSharing("Pairing/duty ended or dispatch disabled GPS. Sharing stopped."));
                else handler.post(() -> { if (!stopping) update("retrying", "GPS upload unavailable. Dispatch will label your last fix stale; retrying while duty is active."); });
            } catch (Exception e) {
                handler.post(() -> { if (!stopping) update("retrying", "No connection to dispatch. Only the latest fresh fix is retried; no route history is stored."); });
            } finally { if (wake != null && wake.isHeld()) wake.release(); uploadScheduled.set(false); }
        });
    }
    private void stopSharing(String message) {
        if (stopping) return;
        stopping = true; active = false; latest = null; handler.removeCallbacksAndMessages(null);
        if (locationManager != null) try { locationManager.removeUpdates(this); } catch (Exception ignored) {}
        RiderApi.prefs(this).edit().putBoolean("running", false).putBoolean("pending_stop", true).apply();
        RiderApi.status(this, "stopped", message + " If offline, dispatch's last fix becomes stale until the stop is confirmed.");
        worker.execute(() -> {
            try {
                RiderApi.pairedRequest(this, "POST", "/api/rider/duty/stop", new JSONObject());
                RiderApi.prefs(this).edit().putBoolean("pending_stop", false).apply();
            } catch (Exception ignored) { /* App resume retries stop; never restart GPS to retry it. */ }
            finally { handler.post(this::stopSelf); }
        });
        stopForeground(true);
    }
    @Override public void onProviderDisabled(String provider) { if (!stopping) update("waiting", "Phone location provider is off. The last fix may be stale; enable Location or stop sharing."); }
    @Override public void onProviderEnabled(String provider) { if (!stopping) requestLocations(); }
    @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() {
        stopping = true; active = false; latest = null; handler.removeCallbacksAndMessages(null);
        if (locationManager != null) try { locationManager.removeUpdates(this); } catch (Exception ignored) {}
        RiderApi.prefs(this).edit().putBoolean("running", false).apply();
        worker.shutdown(); super.onDestroy();
    }
}
