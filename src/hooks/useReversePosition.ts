import { useMutation, useQueryClient } from "@tanstack/react-query";
import { reversePosition } from "@/api/trading";
import type { ReversePositionPayload } from "@/types/trading";

export function useReversePosition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ReversePositionPayload) => reversePosition(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trading", "accounts"] });
    },
  });
}
