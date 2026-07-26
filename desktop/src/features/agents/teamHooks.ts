import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createTeam,
  deleteTeam,
  listTeams,
  updateTeam,
} from "@/shared/api/tauriTeams";
import type {
  AgentTeam,
  CreateTeamInput,
  UpdateTeamInput,
} from "@/shared/api/types";

export const teamsQueryKey = ["teams"] as const;
const IS_WEB = import.meta.env?.VITE_PLATFORM === "web";

export function useTeamsQuery(options?: { enabled?: boolean }) {
  return useQuery({
    enabled: !IS_WEB && (options?.enabled ?? true),
    queryKey: teamsQueryKey,
    queryFn: listTeams,
    staleTime: 30_000,
    // No refetchInterval: inbound relay team changes emit `agents-data-changed`
    // (handled by useAgentsDataRefresh). Same redundant-poll removal as
    // usePersonasQuery.
  });
}

export function useCreateTeamMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateTeamInput) => createTeam(input),
    onSuccess: (created) => {
      queryClient.setQueryData<AgentTeam[]>(teamsQueryKey, (current) => {
        const next = current ?? [];
        return [created, ...next.filter((team) => team.id !== created.id)];
      });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: teamsQueryKey });
    },
  });
}

export function useUpdateTeamMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateTeamInput) => updateTeam(input),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: teamsQueryKey });
    },
  });
}

export function useDeleteTeamMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteTeam(id),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: teamsQueryKey });
    },
  });
}
