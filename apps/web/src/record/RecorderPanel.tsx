import { latencyFrames } from "@bandroom/audio-engine";
import { DEFAULT_MAX_TAKE_MINUTES, getMeta, getMyUsage } from "@bandroom/shared";
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  NumberInput,
  Progress,
  SegmentedControl,
  Select,
  Slider,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconHeadphones,
  IconInfoCircle,
  IconMicrophone,
  IconPlayerStopFilled,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../api/client";
import { useCurrentUser } from "../auth/session";
import { metaKey } from "../branding/BrandLogo";
import { formatBytes } from "../lib/media";
import { useOnline } from "../offline/online";
import { useClickSettings } from "../rehearse/ClickControls";
import { recordingEngine, setClickSettings, setMaxTakeMinutes } from "../rehearse/controller";
import { useTempoUi } from "../tempo/store";
import { formatGain, parseGain } from "../rehearse/VersionGain";
import {
  clampInputGain,
  estimateTakeBytes,
  formatTakeTime,
  INPUT_GAIN_MAX_DB,
  INPUT_GAIN_MIN_DB,
  INPUT_GAIN_STEP_DB,
  meterPercent,
  minutesThatFit,
} from "./model";
import { recordingSupported } from "./opfs";
import {
  armRecorder,
  clearTake,
  disarmRecorder,
  listInputs,
  closeInput,
  openInput,
  inputChannelsOf,
  resetClip,
  setInputGain,
  startRecorder,
  stopRecorder,
  useRecorder,
} from "./recorder";
import { finalizeTake, newTakePort, prepareTake } from "./takeWriterClient";
import { useTakes } from "./takes";

/** Where a take goes: a song (new track or version) or the project (a new song). */
export interface RecordScope {
  mode: "song" | "project";
  songId: string | null;
  projectId: string;
}

/** The engine holds the song to record on within this long (a preview moving in, a load). */
const ENGINE_WAIT_MS = 15_000;

function waitForEngine(): Promise<boolean> {
  const until = Date.now() + ENGINE_WAIT_MS;
  return new Promise((resolve) => {
    const check = () => {
      if (recordingEngine()) resolve(true);
      else if (Date.now() > until) resolve(false);
      else setTimeout(check, 100);
    };
    check();
  });
}

/** A translated message for a failed microphone open or arming. */
export function micErrorText(t: TFunction, err: unknown): string {
  const name = err instanceof Error || err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return t("record.errors.denied");
  if (name === "NotFoundError" || name === "OverconstrainedError") return t("record.errors.noMic");
  if (name === "NotReadableError" || name === "AbortError") return t("record.errors.busy");
  return t("record.errors.failed");
}

/** Free space for takes: the server quota and this device's storage (null = unknown). */
function useTakeSpace(online: boolean) {
  const usage = useQuery({
    queryKey: ["me", "usage"],
    queryFn: ({ signal }) => api(getMyUsage, undefined, { signal }),
    enabled: online,
  });
  const [local, setLocal] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    navigator.storage
      .estimate()
      .then((e) => {
        if (live && e.quota !== undefined) setLocal(Math.max(0, e.quota - (e.usage ?? 0)));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const server =
    usage.data && usage.data.quotaBytes !== null
      ? Math.max(0, usage.data.quotaBytes - usage.data.usedBytes)
      : null;
  return { server, local };
}

/**
 * The input gain (SPEC §9): a digital gain before writing, set with the slider or typed in dB.
 * Usable while armed and while recording; the meter shows the result.
 */
function InputGain() {
  const { t } = useTranslation();
  const gain = useRecorder((s) => s.inputGainDb);
  const [draft, setDraft] = useState<string | number | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = parseGain(draft);
    setDraft(null);
    if (v !== null) setInputGain(clampInputGain(v));
  };
  return (
    <Stack gap={4}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text size="sm" fw={500}>
          {t("record.inputGain")}
        </Text>
        <Text size="xs" c="dimmed" ta="right">
          {t("record.inputGainHint")}
        </Text>
      </Group>
      <Group gap="sm" wrap="nowrap">
        <Slider
          style={{ flex: 1 }}
          min={INPUT_GAIN_MIN_DB}
          max={INPUT_GAIN_MAX_DB}
          step={INPUT_GAIN_STEP_DB}
          value={gain}
          onChange={(v) => {
            setDraft(null);
            setInputGain(v);
          }}
          label={(v) => formatGain(v, t)}
          thumbSize={20}
          thumbProps={{ "aria-label": t("record.inputGain") }}
          data-testid="record-gain-slider"
        />
        <NumberInput
          w={96}
          size="sm"
          styles={{ input: { minHeight: 44 } }}
          value={draft ?? gain}
          onChange={setDraft}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setDraft(null);
          }}
          min={INPUT_GAIN_MIN_DB}
          max={INPUT_GAIN_MAX_DB}
          step={INPUT_GAIN_STEP_DB}
          decimalScale={2}
          allowDecimal
          allowNegative={false}
          clampBehavior="none"
          // The spin buttons would be far below 44 px (touch targets); arrow keys still step.
          hideControls
          inputMode="decimal"
          suffix=" dB"
          aria-label={t("record.inputGain")}
          data-testid="record-gain-input"
        />
      </Group>
    </Stack>
  );
}

/**
 * The recorder (SPEC §9): opens the microphone and arms on mount, shows the input meter, the
 * device and Mono/Stereo choices, the count-in, the warnings, and Record; while recording the
 * timer, the meter and Stop. A take that ends (Stop or an interruption) calls `onTakeEnded`; the
 * stop dialog then comes from the take writer. Unmounting disarms (a take in progress ends).
 */
export function RecorderPanel({
  scope,
  onTakeEnded,
}: {
  scope: RecordScope;
  onTakeEnded: () => void;
}) {
  const { t, i18n } = useTranslation();
  const user = useCurrentUser();
  const online = useOnline();
  const phase = useRecorder((s) => s.phase);
  const channels = useRecorder((s) => s.channels);
  const inputChannels = useRecorder((s) => s.inputChannels);
  const inputLabel = useRecorder((s) => s.inputLabel);
  const peaks = useRecorder((s) => s.peaks);
  const clipped = useRecorder((s) => s.clipped);
  const recFrames = useRecorder((s) => s.recFrames);
  const bluetooth = useRecorder((s) => s.bluetooth);
  const practiceReset = useRecorder((s) => s.practiceReset);
  const take = useRecorder((s) => s.take);
  const writerError = useTakes((s) => s.writerError);
  const hasTempo = useTempoUi(
    (s) => scope.songId !== null && s.songId === scope.songId && s.grid !== null,
  );
  const click = useClickSettings();
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [stereo, setStereo] = useState(true);
  const arming = useRef(0);
  /** Takes count only once this panel armed (not one left from before). */
  const armedOnce = useRef(false);

  const meta = useQuery({
    queryKey: metaKey,
    queryFn: ({ signal }) => api(getMeta, undefined, { signal }),
    staleTime: 5 * 60_000,
  });
  const maxMinutes = meta.data?.recordingMaxTakeMinutes ?? DEFAULT_MAX_TAKE_MINUTES;
  useEffect(() => {
    setMaxTakeMinutes(maxMinutes);
  }, [maxMinutes]);
  const space = useTakeSpace(online);

  const supported = recordingSupported();
  const arm = async (device: string | null, wantStereo: boolean) => {
    const run = ++arming.current;
    if (!supported) return;
    disarmRecorder();
    let stream: MediaStream;
    try {
      stream = await openInput({
        ...(device ? { deviceId: device } : {}),
        channels: wantStereo ? 2 : 1,
      });
    } catch (err) {
      if (run === arming.current) setError(micErrorText(t, err));
      return;
    }
    if (run !== arming.current || !(await waitForEngine()) || run !== arming.current) {
      closeInput(stream);
      if (run === arming.current) setError(t("record.errors.notLoaded"));
      return;
    }
    try {
      const ch = inputChannelsOf(stream) === 2 && wantStereo ? 2 : 1;
      await armRecorder({ stream, channels: ch, port: newTakePort() });
      armedOnce.current = true;
    } catch (err) {
      closeInput(stream);
      if (run === arming.current) setError(micErrorText(t, err));
      return;
    }
    // Labels are known once the permission was given.
    const inputs = await listInputs().catch(() => []);
    if (run === arming.current) setDevices(inputs);
  };

  useEffect(() => {
    const runs = arming;
    void arm(null, true);
    return () => {
      runs.current++;
      // Closed while recording: the take ends as with Stop (kept; its dialog follows).
      if (useRecorder.getState().phase === "recording") {
        void stopRecorder()
          .then((ended) => {
            if (!ended.confirmed) finalizeTake(ended.endedBy);
          })
          .catch(() => undefined)
          .finally(() => {
            clearTake();
            disarmRecorder();
          });
        return;
      }
      disarmRecorder();
      clearTake();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- arm once; choices re-arm explicitly
  }, []);

  // A take ended (Stop, max length, an interruption): its dialog comes from the take writer.
  useEffect(() => {
    if (!take || !armedOnce.current) return;
    // The audio context went away first: the writer finishes what it received.
    if (!take.confirmed) finalizeTake(take.endedBy);
    clearTake();
    disarmRecorder();
    onTakeEnded();
  }, [take, onTakeEnded]);

  // Writing failed (storage full): the take stops; what was written is recovered.
  useEffect(() => {
    if (writerError && phase === "recording") void stopRecorder().catch(() => undefined);
  }, [writerError, phase]);

  const need = estimateTakeBytes(maxMinutes, channels);
  const free = Math.min(
    space.server ?? Number.POSITIVE_INFINITY,
    space.local ?? Number.POSITIVE_INFINITY,
  );
  const fits = Number.isFinite(free) ? minutesThatFit(free, channels) : null;
  const noSpace = fits !== null && fits < 1;
  const lowSpace = fits !== null && !noSpace && free < need;
  const locale = i18n.resolvedLanguage ?? "en";

  const record = () => {
    if (useRecorder.getState().phase !== "armed" || noSpace) return;
    useTakes.setState({ writerError: null });
    startRecorder();
    const latency = useRecorder.getState().latency ?? { outputSec: 0, inputSec: 0 };
    prepareTake({
      userId: user.id,
      mode: scope.mode,
      songId: scope.songId,
      projectId: scope.projectId,
      latencyFrames: latencyFrames(latency),
    });
  };

  const recording = phase === "recording" || phase === "stopping";
  const meters = (
    <Stack gap={4} data-testid="record-meter">
      {(channels === 2 ? [0, 1] : [0]).map((c) => {
        const v = meterPercent(peaks[c] ?? 0);
        return (
          <Progress
            key={c}
            value={v}
            size="lg"
            transitionDuration={0}
            color={v > 97 ? "red" : v > 90 ? "yellow" : "teal"}
            aria-label={t("record.level")}
          />
        );
      })}
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text size="xs" c="dimmed" truncate>
          {inputLabel || t("record.input")}
        </Text>
        {clipped && (
          <Badge
            component="button"
            type="button"
            color="red"
            variant="filled"
            onClick={resetClip}
            style={{ cursor: "pointer", minHeight: 24 }}
            data-testid="record-clip"
            title={t("record.clipReset")}
          >
            {t("record.clip")}
          </Badge>
        )}
      </Group>
    </Stack>
  );

  const shownError = supported ? error : t("record.errors.unsupported");
  if (shownError) {
    return (
      <Stack gap="md" data-testid="record-panel">
        <Alert color="red" icon={<IconAlertTriangle size={18} />} data-testid="record-error">
          {shownError}
        </Alert>
        {supported && (
          <Button
            variant="default"
            h={44}
            onClick={() => {
              setError(null);
              void arm(deviceId, stereo);
            }}
          >
            {t("common.retry")}
          </Button>
        )}
      </Stack>
    );
  }

  return (
    <Stack gap="md" data-testid="record-panel" data-phase={phase}>
      {phase === "off" || phase === "arming" ? (
        <Group gap="xs">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            {t("record.opening")}
          </Text>
        </Group>
      ) : (
        <>
          {meters}
          <InputGain />
        </>
      )}

      {!recording && (
        <>
          {devices.length > 1 && (
            <Select
              label={t("record.device")}
              data={devices.map((d, i) => ({
                value: d.deviceId,
                label: d.label || t("record.deviceN", { n: i + 1 }),
              }))}
              value={deviceId ?? devices.find((d) => d.label === inputLabel)?.deviceId ?? null}
              allowDeselect={false}
              onChange={(v) => {
                setDeviceId(v);
                void arm(v, stereo);
              }}
              comboboxProps={{ withinPortal: true }}
              data-testid="record-device"
            />
          )}
          {inputChannels === 2 && (
            <SegmentedControl
              value={channels === 2 ? "stereo" : "mono"}
              data={[
                { value: "stereo", label: t("record.stereo") },
                { value: "mono", label: t("record.mono") },
              ]}
              onChange={(v) => {
                setStereo(v === "stereo");
                void arm(deviceId, v === "stereo");
              }}
              data-testid="record-channels"
            />
          )}
          {scope.mode === "song" && hasTempo && (
            <Switch
              size="md"
              label={t("click.countIn")}
              checked={click.countIn}
              onChange={(e) => {
                setClickSettings({ countIn: e.currentTarget.checked });
              }}
              data-testid="record-count-in"
            />
          )}
          {scope.mode === "song" && (
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <IconHeadphones size={18} style={{ flex: "none", marginTop: 2 }} aria-hidden />
              <Text size="sm" c="dimmed">
                {t("record.plays")} {t("record.headphones")}
              </Text>
            </Group>
          )}
          {practiceReset && (
            <Alert
              color="blue"
              icon={<IconInfoCircle size={18} />}
              data-testid="record-practice-reset"
            >
              {t("record.practiceReset")}
            </Alert>
          )}
          {bluetooth && (
            <Alert
              color="yellow"
              icon={<IconAlertTriangle size={18} />}
              data-testid="record-bluetooth"
            >
              {t("record.bluetooth")}
            </Alert>
          )}
          {noSpace && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />} data-testid="record-no-space">
              {t("record.noSpace")}
            </Alert>
          )}
          {lowSpace && (
            <Alert
              color="yellow"
              icon={<IconAlertTriangle size={18} />}
              data-testid="record-low-space"
            >
              {t("record.lowSpace", {
                minutes: fits,
                free: formatBytes(free, locale),
                max: maxMinutes,
              })}
            </Alert>
          )}
          {!online && (
            <Text size="sm" c="dimmed" data-testid="record-offline">
              {t("record.offlineHint")}
            </Text>
          )}
        </>
      )}

      {writerError && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} data-testid="record-writer-error">
          {t("record.errors.writer")}
        </Alert>
      )}

      {recording ? (
        <Stack gap="sm" align="center">
          <Group gap="xs" align="center">
            <Box
              w={12}
              h={12}
              style={{ borderRadius: "50%", background: "var(--mantine-color-red-filled)" }}
              aria-hidden
            />
            <Text size="32px" fw={700} className="tabular-nums" data-testid="record-timer">
              {formatTakeTime(recFrames)}
            </Text>
          </Group>
          <Button
            size="lg"
            h={56}
            fullWidth
            color="gray"
            leftSection={<IconPlayerStopFilled size={22} />}
            loading={phase === "stopping"}
            onClick={() => {
              void stopRecorder().catch(() => undefined);
            }}
            data-testid="record-stop"
          >
            {t("record.stop")}
          </Button>
        </Stack>
      ) : (
        <Button
          size="lg"
          h={56}
          fullWidth
          color="red"
          leftSection={<IconMicrophone size={22} />}
          disabled={phase !== "armed" || noSpace}
          onClick={record}
          data-testid="record-start"
        >
          {t("record.record")}
        </Button>
      )}
    </Stack>
  );
}
