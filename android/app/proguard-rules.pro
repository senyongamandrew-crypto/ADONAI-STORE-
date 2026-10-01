# Adonai POS — ProGuard rules
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.adonaithrift.pos.** { *; }
-dontwarn android.webkit.**
