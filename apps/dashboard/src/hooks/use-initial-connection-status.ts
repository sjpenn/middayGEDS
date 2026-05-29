import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTRPC } from "@/trpc/client";

type UseInitialConnectionStatusProps = {
  runId?: string;
  // Kept for backwards compatibility with callers. No longer used now that the
  // initial sync runs on BullMQ instead of Trigger.dev realtime.
  accessToken?: string;
};

/**
 * Tracks the status of the initial bank connection sync.
 *
 * The sync runs as a BullMQ job ("initial-bank-setup"). `runId` is the composite
 * job id ("transactions:<id>") returned by bankConnections.create. We poll
 * jobs.getStatus until the job completes or fails.
 */
export function useInitialConnectionStatus({
  runId: initialRunId,
}: UseInitialConnectionStatusProps) {
  const trpc = useTRPC();
  const [runId, setRunId] = useState<string | undefined>(initialRunId);
  const [status, setStatus] = useState<
    "FAILED" | "SYNCING" | "COMPLETED" | null
  >(null);

  useEffect(() => {
    if (initialRunId) {
      setRunId(initialRunId);
      setStatus("SYNCING");
    }
  }, [initialRunId]);

  const { data, isError } = useQuery({
    ...trpc.jobs.getStatus.queryOptions({ jobId: runId ?? "" }),
    enabled: !!runId,
    // Poll until the job reaches a terminal state.
    refetchInterval: (query) => {
      const jobStatus = query.state.data?.status;
      return jobStatus === "completed" || jobStatus === "failed" ? false : 2000;
    },
  });

  useEffect(() => {
    if (isError || data?.status === "failed") {
      setStatus("FAILED");
      return;
    }

    if (data?.status === "completed") {
      setStatus("COMPLETED");
      return;
    }

    if (data) {
      setStatus("SYNCING");
    }
  }, [data, isError]);

  return {
    status,
    setStatus,
  };
}
