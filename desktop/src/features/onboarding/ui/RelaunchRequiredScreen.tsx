import { RecoveryScreen } from "./RecoveryScreen";

export function RelaunchRequiredScreen() {
  return (
    <RecoveryScreen
      testId="relaunch-required"
      title="Restart EcomBrain Teams to finish recovery"
      body="Your identity was updated. EcomBrain Teams needs to restart so syncing and agents run under it."
    />
  );
}
