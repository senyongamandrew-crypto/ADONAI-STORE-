package com.adonaithrift.pos;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.widget.Toast;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.UUID;

/** User-selected bonded Classic SPP device. Only bounded raster data crosses the bridge. */
final class ThermalPrinter {
    static final int REQUEST = 1010;
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private String image;
    private int dots, height;
    private volatile int generation;
    private BluetoothSocket socket;
    private AlertDialog dialog;
    ThermalPrinter(Activity activity) { this.activity = activity; }

    synchronized boolean reserve(String data, int width, int rows) {
        if (image != null || data == null || (width != 384 && width != 576) || rows < 1 || rows > 12000
                || data.length() != 4 * ((rows * (width/8) + 2)/3)) return false;
        image = data; dots = width; height = rows; return true;
    }
    void start() {
        if (image == null) return;
        if (Build.VERSION.SDK_INT >= 31 && activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, REQUEST);
        } else choose();
    }
    void permission(boolean granted) {
        if (image == null) return;
        if (granted) choose(); else finish("Allow Nearby devices to choose your paired receipt printer.");
    }
    private void choose() {
        try {
            BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
            if (adapter == null || !adapter.isEnabled()) { finish("Turn on Bluetooth and pair your thermal printer in Settings."); return; }
            ArrayList<BluetoothDevice> devices = new ArrayList<>();
            ArrayList<String> names = new ArrayList<>();
            for (BluetoothDevice device : adapter.getBondedDevices()) {
                if (device.getType() == BluetoothDevice.DEVICE_TYPE_LE) continue;
                devices.add(device); names.add(device.getName() + "\n" + device.getAddress());
            }
            if (devices.isEmpty()) { finish("No paired Bluetooth Classic devices. Pair an ESC/POS printer in Settings and try again."); return; }
            dialog = new AlertDialog.Builder(activity).setTitle("Choose your paired ESC/POS printer")
                .setItems(names.toArray(new String[0]), (d,i) -> send(devices.get(i)))
                .setNegativeButton("Cancel", (d,i) -> cancel()).setOnCancelListener(d -> cancel()).show();
        } catch (RuntimeException e) { finish("Cannot access Bluetooth. Check Nearby devices permission and try again."); }
    }
    private void send(BluetoothDevice device) {
        final String data = image;
        final int stride = dots/8, rows = height, job = generation;
        Runnable timeout = () -> { if (generation == job) finish("Printer timed out. Check the paper before retrying."); };
        main.postDelayed(timeout, 90000);
        new Thread(() -> {
            String result = "Receipt sent to thermal printer.";
            try (BluetoothSocket out = device.createRfcommSocketToServiceRecord(SPP)) {
                synchronized (this) { if (generation != job) return; socket = out; }
                byte[] raster = Base64.decode(data, Base64.NO_WRAP);
                if (raster.length != stride * rows) throw new IOException("Invalid raster");
                out.connect();
                OutputStream stream = out.getOutputStream();
                stream.write(new byte[]{27,64}); // ESC @ initialize; GS v 0 raster bands
                for (int y=0; y<rows; y+=32) {
                    int n = Math.min(32, rows-y);
                    stream.write(new byte[]{29,118,48,0,(byte)stride,0,(byte)n,0});
                    stream.write(raster,y*stride,n*stride);
                }
                stream.write(new byte[]{10,10,10}); stream.flush();
            } catch (IOException | RuntimeException e) { result = "Print failed. Check printer power, pairing, paper and ESC/POS support before retrying."; }
            finally { main.removeCallbacks(timeout); }
            final String message = result;
            main.post(() -> { if (generation == job) finish(message); });
        }, "ReceiptPrinter").start();
    }
    private void finish(String message) {
        cancel();
        Toast.makeText(activity,message,Toast.LENGTH_LONG).show();
    }
    synchronized void cancel() {
        generation++; image = null;
        if (dialog != null) { dialog.dismiss(); dialog = null; }
        if (socket != null) { try { socket.close(); } catch (IOException ignored) {} socket = null; }
    }
}
