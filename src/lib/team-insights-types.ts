export interface EstimationInsight {
  issueType: string;
  medianCycleDays: number;
  pointsToDaysRatio: number;
  estimationAccuracy: number;
  pointsDistribution: Record<number, number>;
  sampleSize: number;
}

export interface OwnershipInsight {
  component: string;
  owners: Array<{
    assignee: string;
    ticketCount: number;
    percentage: number;
    avgCycleDays: number;
  }>;
  sampleSize: number;
}

export interface TemplateInsight {
  issueType: string;
  headings: Array<{
    text: string;
    frequency: number;
  }>;
  acFormat: "checkbox" | "given-when-then" | "numbered" | "prose" | "none";
  avgAcItems: number;
  templateSkeleton: string;
  sampleSize: number;
}

export interface PatternInsight {
  priorityDistribution: Record<string, Record<string, number>>;
  labelCooccurrence: Array<{
    labelA: string;
    labelB: string;
    cooccurrenceRate: number;
    count: number;
  }>;
  reworkRates: Array<{
    component: string;
    reopenRate: number;
    totalTickets: number;
    reopenedTickets: number;
  }>;
}

export interface TeamInsights {
  estimation: EstimationInsight[];
  ownership: OwnershipInsight[];
  templates: TemplateInsight[];
  patterns: PatternInsight;
}
