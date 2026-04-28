import { useMemo } from "react";
import { format, parseISO } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  EmptyHeader,
  EmptyTitle,
  Skeleton
} from "@app/components/v3";
import { useProject } from "@app/context";
import { useGetPamSessionActivity } from "@app/hooks/api/pamInsights";

type ChartPoint = {
  date: string;
  count: number;
  label: string;
  showTickLabel: string | null;
};

const buildAxisTicks = (data: ChartPoint[]): string[] => {
  if (!data.length) return [];
  const ticks: string[] = [];
  data.forEach((point, index) => {
    if (index === 0 || index === data.length - 1) {
      ticks.push(point.date);
      return;
    }
    if (index % 7 === 0) ticks.push(point.date);
  });
  return ticks;
};

export const PamSessionActivityChart = () => {
  const { projectId } = useProject();
  const { data, isPending } = useGetPamSessionActivity({ projectId }, { enabled: !!projectId });

  const chartData = useMemo<ChartPoint[]>(() => {
    if (!data?.days) return [];
    return data.days.map((day, index, days) => {
      const isLast = index === days.length - 1;
      const isFirst = index === 0;
      const parsed = parseISO(day.date);
      let tickLabel: string | null = null;
      if (isLast) tickLabel = "Today";
      else if (isFirst || index % 7 === 0) tickLabel = format(parsed, "MMM d");
      return {
        date: day.date,
        count: day.count,
        label: format(parsed, "MMM d"),
        showTickLabel: tickLabel
      };
    });
  }, [data]);

  const ticks = useMemo(() => buildAxisTicks(chartData), [chartData]);
  const totalSessions = chartData.reduce((sum, d) => sum + d.count, 0);
  const hasAnyData = totalSessions > 0;

  const renderBody = () => {
    if (isPending) return <Skeleton className="h-[280px] w-full" />;
    if (!hasAnyData) {
      return (
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyTitle>No sessions in the last 30 days</EmptyTitle>
          </EmptyHeader>
        </Empty>
      );
    }
    return (
      <div className="flex flex-col gap-4 [&_*]:focus:outline-none [&_*:focus]:outline-none">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="4 4" stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="date"
              ticks={ticks}
              tickFormatter={(date: string) => {
                const point = chartData.find((p) => p.date === date);
                return point?.showTickLabel ?? "";
              }}
              tick={{ fontSize: 11, fill: "var(--color-label)" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--color-label)" }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-popover)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12
              }}
              labelStyle={{ color: "var(--color-foreground)" }}
              itemStyle={{ color: "var(--color-primary)" }}
              cursor={false}
              isAnimationActive={false}
              labelFormatter={(date) => {
                const point = chartData.find((p) => p.date === date);
                return point?.label ?? String(date);
              }}
              formatter={(value) => [Number(value).toLocaleString(), "Sessions"]}
            />
            <Bar
              dataKey="count"
              fill="var(--color-primary)"
              radius={[2, 2, 0, 0]}
              style={{ outline: "none" }}
            />
          </BarChart>
        </ResponsiveContainer>
        <span className="text-xs text-muted">
          {totalSessions.toLocaleString()} sessions in the last 30 days &middot;{" "}
          {(data?.avgPerDay ?? 0).toLocaleString()} per day on average
        </span>
      </div>
    );
  };

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Session Activity</CardTitle>
        <CardDescription>Privileged sessions started over the past 30 days</CardDescription>
      </CardHeader>
      <CardContent>{renderBody()}</CardContent>
    </Card>
  );
};
