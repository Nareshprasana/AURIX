import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Layout } from "./components/layout";
import { Overview } from "./pages/Overview";
import { Data, Portfolio, Research, Strategies } from "./pages/placeholders";
import { RiskGovernance, Training } from "./pages/Training";
import { Settings, SystemHealth } from "./pages/System";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Overview /> },
      { path: "research", element: <Research /> },
      { path: "training", element: <Training /> },
      { path: "data", element: <Data /> },
      { path: "strategies", element: <Strategies /> },
      { path: "portfolio", element: <Portfolio /> },
      { path: "risk", element: <RiskGovernance /> },
      { path: "health", element: <SystemHealth /> },
      { path: "settings", element: <Settings /> },
      { path: "*", element: <Overview /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
