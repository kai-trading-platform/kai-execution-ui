import { useMutation, useQueryClient } from "@tanstack/react-query";
import { closeTradingPosition } from "@/api/trading";
import type { CloseTradingPositionPayload } from "@/types/trading";

export function useCloseTradingPosition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CloseTradingPositionPayload) => closeTradingPosition(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trading", "accounts"] });
    },
  });
}
