import type { Metadata } from "next";
import {
  PageContainer,
  PageHeader,
  PageTitle,
  PageDescription,
} from "@/components/layout/page-layout";

export const metadata: Metadata = { title: "Requests" };

/**
 * Route placeholder for the application shell (ATL-005).
 *
 * The shell needs every primary destination to resolve so navigation, focus
 * order, and accessibility can be verified. This surface is built by **ATL-064**;
 * it renders no data and contains no business logic.
 */
export default function RequestsPage() {
  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>Requests</PageTitle>
        <PageDescription>Deletion and correction requests you have prepared.</PageDescription>
      </PageHeader>
    </PageContainer>
  );
}
