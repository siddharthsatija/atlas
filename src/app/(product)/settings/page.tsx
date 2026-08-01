import type { Metadata } from "next";
import {
  PageContainer,
  PageHeader,
  PageTitle,
  PageDescription,
} from "@/components/layout/page-layout";

export const metadata: Metadata = { title: "Settings" };

/**
 * Route placeholder for the application shell (ATL-005).
 *
 * The shell needs every primary destination to resolve so navigation, focus
 * order, and accessibility can be verified. This surface is built by **ATL-074 – ATL-077**;
 * it renders no data and contains no business logic.
 */
export default function SettingsPage() {
  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>Settings</PageTitle>
        <PageDescription>Profile, security, privacy, and data controls.</PageDescription>
      </PageHeader>
    </PageContainer>
  );
}
