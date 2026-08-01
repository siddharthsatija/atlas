import type { Metadata } from "next";
import {
  PageContainer,
  PageHeader,
  PageTitle,
  PageDescription,
} from "@/components/layout/page-layout";

export const metadata: Metadata = { title: "Overview" };

/**
 * Route placeholder for the application shell (ATL-005).
 *
 * The shell needs every primary destination to resolve so navigation, focus
 * order, and accessibility can be verified. This surface is built by **ATL-019 – ATL-026**;
 * it renders no data and contains no business logic.
 */
export default function OverviewPage() {
  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>Overview</PageTitle>
        <PageDescription>Your privacy dashboard.</PageDescription>
      </PageHeader>
    </PageContainer>
  );
}
