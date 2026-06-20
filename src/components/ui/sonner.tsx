/* eslint-disable react-refresh/only-export-components -- exporta el helper toast junto al componente Toaster por diseño */
import * as React from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, toast as sonnerToast } from "sonner";
import { CheckCircle2, AlertCircle, AlertTriangle, Info, Loader2 } from "lucide-react";

type ToasterProps = React.ComponentProps<typeof Sonner>;
type SonnerToastOptions = Parameters<typeof sonnerToast>[1];

// Cache para deduplicación de alertas idénticas en ráfagas cortas
const recentToasts = new Map<string, number>();

// Estado interno para control de ráfagas masivas (burst protection)
let burstTimestamps: number[] = [];
let burstTimeout: number | null = null;
let burstPendingCount = 0;

const cleanRecentToasts = (now: number) => {
  for (const [msg, ts] of recentToasts.entries()) {
    if (now - ts > 4000) {
      recentToasts.delete(msg);
    }
  }
};

const emitBufferedToast = (
  method: "success" | "error" | "info" | "warning" | "loading" | "message",
  message: Parameters<typeof sonnerToast>[0],
  options?: SonnerToastOptions,
): string | number => {
  const now = Date.now();
  cleanRecentToasts(now);

  // 1. Deduplicación de mensajes exactos en ventana de 2 segundos
  const msgStr = typeof message === "string"
    ? message
    : message && typeof message === "object" && "toString" in message
      ? message.toString()
      : "";

  if (msgStr) {
    const lastSeen = recentToasts.get(msgStr);
    if (lastSeen && now - lastSeen < 2000) {
      // Ignorar duplicado y devolver ID sintético para no entorpecer
      return `dup-${now}-${Math.random()}`;
    }
    recentToasts.set(msgStr, now);
  }

  // 2. Control de ráfagas masivas (Burst Protection)
  // Filtramos timestamps ocurridos en el último segundo (1000ms)
  burstTimestamps = burstTimestamps.filter((ts) => now - ts < 1000);
  burstTimestamps.push(now);

  // Si se superan 3 notificaciones concurrentes en 1 segundo
  if (burstTimestamps.length >= 4) {
    burstPendingCount += 1;

    if (burstTimeout) {
      window.clearTimeout(burstTimeout);
    }

    // Programamos un consolidado tardío
    burstTimeout = window.setTimeout(() => {
      if (burstPendingCount > 0) {
        const count = burstPendingCount;
        burstPendingCount = 0;
        burstTimestamps = [];
        sonnerToast.info("Sincronización silenciosa", {
          description: `Se procesaron ${count} operaciones adicionales en segundo plano de manera silenciosa.`,
        });
      }
    }, 800);

    return `burst-deferred-${now}`;
  }

  // 3. Emisión estándar
  const nextId =
    method === "success"
      ? sonnerToast.success(message, options)
      : method === "error"
        ? sonnerToast.error(message, options)
        : method === "info"
          ? sonnerToast.info(message, options)
          : method === "warning"
            ? sonnerToast.warning(message, options)
            : method === "loading"
              ? sonnerToast.loading(message, options)
              : sonnerToast(message, options);

  return nextId;
};

type ToastFn = {
  (
    message: Parameters<typeof sonnerToast>[0],
    options?: SonnerToastOptions,
  ): string | number;
  success: (
    message: Parameters<typeof sonnerToast>[0],
    options?: SonnerToastOptions,
  ) => string | number;
  error: (
    message: Parameters<typeof sonnerToast>[0],
    options?: SonnerToastOptions,
  ) => string | number;
  info: (
    message: Parameters<typeof sonnerToast>[0],
    options?: SonnerToastOptions,
  ) => string | number;
  warning: (
    message: Parameters<typeof sonnerToast>[0],
    options?: SonnerToastOptions,
  ) => string | number;
  loading: (
    message: Parameters<typeof sonnerToast>[0],
    options?: SonnerToastOptions,
  ) => string | number;
  dismiss: (id?: string | number) => void;
};

const toast: ToastFn = Object.assign(
  (message: Parameters<typeof sonnerToast>[0], options?: SonnerToastOptions) =>
    emitBufferedToast("message", message, options),
  {
    success: (
      message: Parameters<typeof sonnerToast>[0],
      options?: SonnerToastOptions,
    ) => emitBufferedToast("success", message, options),
    error: (
      message: Parameters<typeof sonnerToast>[0],
      options?: SonnerToastOptions,
    ) => emitBufferedToast("error", message, options),
    info: (
      message: Parameters<typeof sonnerToast>[0],
      options?: SonnerToastOptions,
    ) => emitBufferedToast("info", message, options),
    warning: (
      message: Parameters<typeof sonnerToast>[0],
      options?: SonnerToastOptions,
    ) => emitBufferedToast("warning", message, options),
    loading: (
      message: Parameters<typeof sonnerToast>[0],
      options?: SonnerToastOptions,
    ) => emitBufferedToast("loading", message, options),
    dismiss: (id?: string | number) => {
      sonnerToast.dismiss(id);
    },
  },
);

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      closeButton={true}
      visibleToasts={3}
      expand={true}
      position={isMobile ? "bottom-center" : "top-right"}
      icons={{
        success: <CheckCircle2 className="h-4 w-4 text-[hsl(var(--success))]" />,
        error: <AlertCircle className="h-4 w-4 text-[hsl(var(--destructive))]" />,
        warning: <AlertTriangle className="h-4 w-4 text-[hsl(var(--warning))]" />,
        info: <Info className="h-4 w-4 text-blue-500" />,
        loading: <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />,
      }}
      toastOptions={{
        duration: 4000,
        classNames: {
          toast:
            "group toast w-full rounded-xl border border-border bg-card/95 text-foreground shadow-2xl backdrop-blur-md px-4 py-3.5 flex items-start gap-3 transition-all duration-300 md:max-w-[360px]",
          title: "font-semibold text-foreground text-[13px] tracking-tight leading-snug mb-0.5",
          description: "text-muted-foreground text-[11px] leading-relaxed break-words whitespace-pre-wrap font-medium",
          actionButton:
            "bg-primary text-primary-foreground hover:bg-primary/90 font-semibold text-[11px] rounded-lg px-2.5 py-1.5 transition-colors",
          cancelButton:
            "bg-muted text-muted-foreground hover:bg-muted/80 font-semibold text-[11px] rounded-lg px-2.5 py-1.5 transition-colors",
          closeButton:
            "absolute right-2 top-2 !opacity-0 group-hover:!opacity-100 border-none bg-transparent hover:bg-muted text-muted-foreground hover:text-foreground rounded-lg p-1 transition-all duration-200",
          success: "",
          error: "",
          warning: "",
          info: "",
          loading: "",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
