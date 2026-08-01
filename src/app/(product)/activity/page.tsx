import type { Metadata } from "next";
import {
  PageContainer,
  PageHeader,
  PageTitle,
  PageDescription,
} from "@/components/layout/page-layout";

export const metadata: Metadata = { title: "Activity" };

/**
 * Route placeholder for the application shell (ATL-005).
 *
 * The shell needs every primary destination to resolve so navigation, focus
 * order, and accessibility can be verified. This surface is built by **ATL-070**;
 * it renders no data and contains no business logic.
 */
export default function ActivityPage() {
  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>Activity</PageTitle>
        <PageDescription>A record of actions taken in Atlas.</PageDescription>
      </PageHeader>
    </PageContainer>
  );
}
