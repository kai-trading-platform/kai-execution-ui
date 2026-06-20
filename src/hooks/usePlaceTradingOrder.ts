import { useMutation, useQueryClient } from "@tanstack/react-query";
import { placeTradingOrder } from "@/api/trading";
import type { PlaceTradingOrderPayload } from "@/types/trading";

export function usePlaceTradingOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: PlaceTradingOrderPayload) => placeTradingOrder(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trading-positions"] });
    },
  });
}
