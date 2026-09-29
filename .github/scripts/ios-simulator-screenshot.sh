#!/usr/bin/env bash
# Boots an installed iOS Simulator of one device family, installs and launches
# the app, checks that it is still running, and saves a screenshot.
#
# Usage: ios-simulator-screenshot.sh <iPhone|iPad> <path/to/App.app> <output.png> [launch argument...]
#
# macOS + Xcode only; used by .github/workflows/ios-visual-smoke.yml. Adapted
# from a91453/railway-game-ios (.github/scripts/simulator-screenshot.sh), the
# same owner's iOS pipeline, unchanged in behavior. The device is
# picked at run time from the Simulators installed on the runner instead of a
# hard-coded model name, because runner images add and drop models over time.
# Any arguments after the output path are passed to the app at launch.
# The app's stderr is saved next to the screenshot as <name>-app-stderr.log.
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <iPhone|iPad> <path/to/App.app> <output.png> [launch argument...]" >&2
  exit 64
fi

family="$1"
app_path="$2"
screenshot="$3"
shift 3
launch_args=("$@")
settle_seconds=8

case "$family" in
  iPhone | iPad) ;;
  *)
    echo "::error::Unknown device family '$family' (expected iPhone or iPad)."
    exit 64
    ;;
esac
if [[ ! -d "$app_path" ]]; then
  echo "::error::App bundle not found: $app_path"
  exit 1
fi
command -v jq >/dev/null || { echo "::error::jq is required but not installed."; exit 1; }

info_plist="$app_path/Info.plist"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist")"
minimum_ios="$(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$info_plist")"

mkdir -p "$(dirname "$screenshot")"
out_dir="$(cd "$(dirname "$screenshot")" && pwd)"
name="$(basename "$screenshot" .png)"
stderr_log="$out_dir/$name-app-stderr.log"

# --- Pick a device -----------------------------------------------------------
# The newest available iOS runtime that is not newer than the active Xcode's
# Simulator SDK (major.minor) and not older than the app's MinimumOSVersion.
# Within it, prefer a "Pro" (non-Max) model, otherwise any model of the family.
sdk_version="$(xcrun --sdk iphonesimulator --show-sdk-version)"
selection="$(
  xcrun simctl list --json | jq -r \
    --arg family "$family" --arg sdk "$sdk_version" --arg min "$minimum_ios" '
    def version: split(".") | map(tonumber);
    .devices as $devices
    | [ .runtimes[]
        | select(.isAvailable and (.identifier | test("\\.iOS-")))
        | select((.version | version | .[0:2]) <= ($sdk | version | .[0:2])
                 and (.version | version) >= ($min | version)) ]
    | sort_by(.version | version) | reverse
    | map(. as $runtime
          | ($devices[$runtime.identifier] // [])
          | map(select(.isAvailable
                       and ((.deviceTypeIdentifier // "") | test("\\." + $family + "-"))))
          | sort_by(.name)
          | map(select(.name | test(" Pro\\b") and (test("Max") | not))) + .
          | map("\(.udid)\t\(.name)\t\($runtime.version)"))
    | flatten | first // empty'
)"

if [[ -z "$selection" ]]; then
  echo "::error::No available $family Simulator with iOS >= $minimum_ios and <= SDK $sdk_version."
  xcrun simctl list runtimes
  xcrun simctl list devices available
  exit 1
fi
IFS=$'\t' read -r udid device_name runtime_version <<<"$selection"
echo "Selected $family: $device_name (iOS $runtime_version, $udid); Simulator SDK $sdk_version"
echo "Launch arguments: ${launch_args[*]:-(none)}"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "- **$family:** $device_name, iOS $runtime_version" >>"$GITHUB_STEP_SUMMARY"
fi

shutdown_simulator() {
  xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
}
trap shutdown_simulator EXIT

# --- Boot, install, launch ---------------------------------------------------
# bootstatus -b boots the device and blocks until it has finished booting; the
# calling workflow step's timeout-minutes bounds the wait.
xcrun simctl bootstatus "$udid" -b

xcrun simctl install "$udid" "$app_path"

launch_output=""
for attempt in 1 2 3; do
  # The ${a[@]+...} form keeps an empty array safe under set -u in bash 3.2.
  if launch_output="$(xcrun simctl launch --stderr="$stderr_log" "$udid" "$bundle_id" \
    ${launch_args[@]+"${launch_args[@]}"})"; then
    break
  fi
  if [[ $attempt -eq 3 ]]; then
    echo "::error::Could not launch $bundle_id on $device_name."
    exit 1
  fi
  echo "Launch attempt $attempt failed; retrying in 5 s."
  sleep 5
done
echo "$launch_output"
# simctl prints "<bundle id>: <pid>"; Simulator apps are ordinary host processes.
pid="${launch_output##*: }"

sleep "$settle_seconds"

# --- Verify and capture ------------------------------------------------------
app_running=true
if [[ "$pid" =~ ^[0-9]+$ ]]; then
  kill -0 "$pid" 2>/dev/null || app_running=false
else
  echo "::warning::Could not read the app's pid from simctl; skipping the liveness check."
fi

# Capture even if the app died: the screenshot then shows what was on screen.
xcrun simctl io "$udid" screenshot --type=png "$screenshot"
if [[ ! -s "$screenshot" ]]; then
  echo "::error::Screenshot was not written: $screenshot"
  exit 1
fi
echo "Saved $screenshot"

if [[ "$app_running" != true ]]; then
  echo "::error::$bundle_id exited within ${settle_seconds}s of launch on $device_name; see $name-app-stderr.log and any crash reports."
  exit 1
fi
