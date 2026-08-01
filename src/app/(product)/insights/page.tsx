import type { Metadata } from "next";
import {
  PageContainer,
  PageHeader,
  PageTitle,
  PageDescription,
} from "@/components/layout/page-layout";

export const metadata: Metadata = { title: "Privacy Insights" };

/**
 * Route placeholder for the application shell (ATL-005).
 *
 * The shell needs every primary destination to resolve so navigation, focus
 * order, and accessibility can be verified. This surface is built by **ATL-040**;
 * it renders no data and contains no business logic.
 */
export default function InsightsPage() {
  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>Privacy Insights</PageTitle>
        <PageDescription>Findings from your own records.</PageDescription>
      </PageHeader>
    </PageContainer>
  );
}
