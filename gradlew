#!/bin/sh
#
# Gradle startup script for UN*X — based on the official Gradle-generated wrapper
#

# Resolve symlinks to find the real script location
PRG="$0"
while [ -h "$PRG" ]; do
    ls=$(ls -ld "$PRG")
    link=$(expr "$ls" : '.*-> \(.*\)$')
    case "$link" in
        /*) PRG="$link" ;;
        *)  PRG=$(dirname "$PRG")/"$link" ;;
    esac
done
APP_HOME=$(cd "$(dirname "$PRG")" && pwd)

CLASSPATH="$APP_HOME/gradle/wrapper/gradle-wrapper.jar"

# Find java
if [ -n "$JAVA_HOME" ]; then
    JAVACMD="$JAVA_HOME/bin/java"
else
    JAVACMD="java"
fi

exec "$JAVACMD" \
    -Xmx64m \
    -Xms64m \
    -Dorg.gradle.appname="$(basename "$0")" \
    -classpath "$CLASSPATH" \
    org.gradle.wrapper.GradleWrapperMain \
    "$@"
