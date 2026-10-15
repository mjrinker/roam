# kotlinx.serialization keeps what it needs through its own consumer rules; the API models are plain serializable classes.
-keepattributes *Annotation*, InnerClasses
-dontwarn org.slf4j.**

# The API's models are read by name from JSON: the shrinker must keep them whole.
-keep class com.roam.app.data.** { *; }
-keepclassmembers class com.roam.app.data.** { *** Companion; }
