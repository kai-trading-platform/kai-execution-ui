import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateTradingPositionStops } from "@/api/trading";
import type { UpdateTradingPositionStopsPayload } from "@/types/trading";

export function useUpdateTradingPositionStops() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateTradingPositionStopsPayload) => updateTradingPositionStops(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trading-positions"] });
    },
  });
}
