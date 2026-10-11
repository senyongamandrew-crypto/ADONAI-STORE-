package com.adonaithrift.pos;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.net.URI;
import java.net.URL;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/** App-private rider credentials. Never return the token to a WebView or URL. */
final class RiderApi {
    static final String PREFS = "adonai-rider-device";
    static SharedPreferences prefs(Context context) { return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    static boolean validBase(String base) {
        try {
            URI uri = new URI(base);
            String host = uri.getHost();
            return "https".equalsIgnoreCase(uri.getScheme()) && host != null && host.contains(".")
                    && !host.equalsIgnoreCase("appassets.androidplatform.net") && !host.endsWith(".localhost")
                    && !host.matches("[0-9.]+") && uri.getUserInfo() == null && uri.getQuery() == null
                    && uri.getFragment() == null && (uri.getPort() == -1 || uri.getPort() == 443)
                    && (uri.getPath().isEmpty() || "/".equals(uri.getPath()));
        } catch (Exception e) { return false; }
    }
    static final class ApiError extends Exception {
        final int status;
        ApiError(int status, String message) { super(message); this.status = status; }
    }
    static JSONObject request(String base, String token, String method, String path, JSONObject body) throws Exception {
        if (!validBase(base) || !path.startsWith("/api/rider/")) throw new ApiError(0, "Use the store's HTTPS server address.");
        HttpsURLConnection connection = (HttpsURLConnection) new URL(base.replaceAll("/$", "") + path).openConnection();
        connection.setInstanceFollowRedirects(false); // Never send a pairing/session credential to a redirect.
        connection.setConnectTimeout(8000); connection.setReadTimeout(8000);
        connection.setRequestMethod(method); connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cache-Control", "no-store");
        if (token != null && !token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
        try {
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestProperty("Content-Type", "application/json"); connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream stream = connection.getOutputStream()) { stream.write(bytes); }
            }
            int status = connection.getResponseCode();
            InputStream source = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            if (source != null) try (InputStream stream = source) {
                byte[] chunk = new byte[4096]; int length;
                while ((length = stream.read(chunk)) != -1) {
                    if (buffer.size() + length > 256 * 1024) throw new ApiError(0, "The rider response is too large. Contact dispatch.");
                    buffer.write(chunk, 0, length);
                }
            }
            JSONObject data;
            try { data = new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8)); }
            catch (Exception e) { throw new ApiError(status, "The delivery server did not return a valid response."); }
            if (status < 200 || status >= 300 || !data.optBoolean("ok")) throw new ApiError(status, data.optString("error", "Could not reach dispatch."));
            return data;
        } finally { connection.disconnect(); }
    }
    static JSONObject pairedRequest(Context context, String method, String path, JSONObject body) throws Exception {
        SharedPreferences preferences = prefs(context);
        String token = preferences.getString("token", "");
        if (token.isEmpty()) throw new ApiError(401, "Pair this phone with dispatch first.");
        return request(preferences.getString("base", ""), token, method, path, body);
    }
    static void status(Context context, String state, String message) {
        prefs(context).edit().putString("state", state).putString("message", message).apply();
    }
    static JSONObject state(Context context) throws Exception {
        SharedPreferences preferences = prefs(context);
        boolean active = RiderTrackingService.active;
        String state = preferences.getString("state", "stopped");
        boolean interrupted = !active && ("sharing".equals(state) || "waiting".equals(state) || "retrying".equals(state));
        return new JSONObject().put("paired", !preferences.getString("token", "").isEmpty())
                .put("rider_name", preferences.getString("rider_name", ""))
                .put("base", preferences.getString("base", ""))
                .put("state", interrupted ? "stopped" : state)
                .put("message", interrupted ? "GPS service is not running. Start a new duty explicitly; dispatch may have only an old fix." : preferences.getString("message", "Not sharing GPS."))
                .put("running", RiderTrackingService.active)
                .put("last_upload_ms", preferences.getLong("last_upload_ms", 0));
    }
    private RiderApi() {}
}
