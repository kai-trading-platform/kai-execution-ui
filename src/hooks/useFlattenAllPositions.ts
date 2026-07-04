import { useMutation, useQueryClient } from "@tanstack/react-query";
import { flattenAllPositions } from "@/api/trading";
import type { FlattenAllPositionsPayload } from "@/types/trading";

export function useFlattenAllPositions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: FlattenAllPositionsPayload) =>
      flattenAllPositions(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trading", "accounts"] });
    },
  });
}
