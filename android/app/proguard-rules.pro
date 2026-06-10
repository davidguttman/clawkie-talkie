# WebRTC native bindings are reached via JNI; keep everything.
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class app.clawkietalkie.**$$serializer { *; }
-keepclassmembers class app.clawkietalkie.** { *** Companion; }
-keepclasseswithmembers class app.clawkietalkie.** { kotlinx.serialization.KSerializer serializer(...); }
