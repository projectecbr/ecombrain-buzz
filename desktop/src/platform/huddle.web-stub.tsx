import type { ReactNode } from "react";

export function HuddleProvider({ children }: { children: ReactNode }) {
  return children;
}

export function useHuddle() {
  return {
    activeEphemeralChannelId: null,
    activeSpeakers: [],
    audioDevices: [],
    clearHuddleError: () => undefined,
    huddleError: null,
    isStarting: false,
    joinHuddle: async () => undefined,
    leaveHuddle: async () => true,
    localAudioTrack: null,
    micConnected: false,
    micGain: 1,
    micLevel: 0,
    outputDevices: [],
    pttActive: false,
    selectedDeviceId: "",
    selectedOutputDevice: "",
    setMicGain: () => undefined,
    setSelectedDeviceId: () => undefined,
    setSelectedOutputDevice: () => undefined,
    setVoiceInputMode: async () => undefined,
    startHuddle: async () => undefined,
    voiceInputMode: "voice_activity" as const,
  };
}

export function HuddleBar() {
  return null;
}

export function HuddleIndicator() {
  return null;
}

export function HuddleAttachment() {
  return null;
}

export function buildHuddleChannelName(): string {
  return "";
}

export function formatHuddleActionError(error: unknown): string {
  return error instanceof Error ? error.message : "Huddles are desktop-only.";
}
