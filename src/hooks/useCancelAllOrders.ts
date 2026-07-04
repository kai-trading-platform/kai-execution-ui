import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cancelAllOrders } from "@/api/trading";
import type { CancelAllOrdersPayload } from "@/types/trading";

export function useCancelAllOrders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CancelAllOrdersPayload) => cancelAllOrders(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trading", "accounts"] });
    },
  });
}
