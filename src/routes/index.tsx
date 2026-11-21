import { createFileRoute } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { DeskApp } from "@/components/desk/DeskApp";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <DeskApp />
    </QueryClientProvider>
  );
}
