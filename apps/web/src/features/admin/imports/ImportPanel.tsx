import { Alert, Badge, Button, Group, Loader, Stack } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { errorMessage } from "../../../api/errorMessage";
import { ImportReportView } from "./ImportReportView";
import { ImportRuns } from "./ImportRuns";
import { MappingReview } from "./MappingReview";
import { useImportRun } from "./queries";
import { RunProgress } from "./RunProgress";
import { STATUS_COLORS } from "./runStatus";
import { SelectProjects } from "./SelectProjects";

/** Admin → Import (SPEC §17.1): list of runs, or the wizard for one run (`?run=`). */
export function ImportPanel() {
  const [params, setParams] = useSearchParams();
  const runId = params.get("run");
  const open = (id: string | null) => {
    setParams(id ? { tab: "import", run: id } : { tab: "import" }, { replace: false });
  };
  return runId ? (
    <ImportWizard
      runId={runId}
      onBack={() => {
        open(null);
      }}
    />
  ) : (
    <ImportRuns onOpen={open} />
  );
}

function ImportWizard({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { t } = useTranslation();
  const q = useImportRun(runId);
  const run = q.data?.run;
  return (
    <Stack>
      <Group justify="space-between">
        <Button
          variant="subtle"
          leftSection={<IconArrowLeft size={16} />}
          onClick={onBack}
          px={0}
          h={44}
        >
          {t("admin.import.back")}
        </Button>
        {run && (
          <Badge color={STATUS_COLORS[run.status]} variant="light" data-testid="import-status">
            {t(`admin.import.status.${run.status}`)}
          </Badge>
        )}
      </Group>
      {q.isPending && <Loader />}
      {q.isError && <Alert color="red">{errorMessage(t, q.error)}</Alert>}
      {run?.status === "connected" && <SelectProjects run={run} />}
      {(run?.status === "scanning" || run?.status === "running") && <RunProgress run={run} />}
      {run?.status === "review" && <MappingReview key={run.updatedAt} run={run} />}
      {run && ["done", "failed", "cancelled"].includes(run.status) && (
        <ImportReportView run={run} onDone={onBack} />
      )}
    </Stack>
  );
}
