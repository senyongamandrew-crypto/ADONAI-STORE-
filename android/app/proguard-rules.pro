# Keep the JavaScript bridge methods callable from Android WebView.
-keepclassmembers class com.adonaithrift.pos.MainActivity$AndroidBridge {
    <methods>;
}
