using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Vibe.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddUnifiedTaskTiming : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Discard only transient pre-U1 snapshots/pins. All historical domain JSON,
            // completion context, operation bytes, feed rows and stream positions survive.
            migrationBuilder.Sql("DELETE FROM \"SyncSnapshotItems\"; DELETE FROM \"SyncSnapshots\";");
            migrationBuilder.DropCheckConstraint(
                name: "CK_RecurrenceRule_Days",
                table: "RecurrenceRules");

            migrationBuilder.AlterColumn<DateOnly>(
                name: "LogicalDate",
                table: "TaskOccurrences",
                type: "date",
                nullable: true,
                oldClrType: typeof(DateOnly),
                oldType: "date");

            migrationBuilder.AddColumn<string>(
                name: "PlacementIssue",
                table: "TaskOccurrences",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ResolvedTimingJson",
                table: "TaskOccurrences",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TimeIntentJson",
                table: "TaskOccurrences",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddColumn<DateOnly>(
                name: "AnchorDate",
                table: "RecurrenceRules",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "IntervalDays",
                table: "RecurrenceRules",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Pattern",
                table: "RecurrenceRules",
                type: "text",
                nullable: false,
                defaultValue: "weekly");

            migrationBuilder.AddColumn<string>(
                name: "TimeIntentJson",
                table: "RecurrenceRules",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddCheckConstraint(
                name: "CK_RecurrenceRule_Days",
                table: "RecurrenceRules",
                sql: "(\"Pattern\" = 'weekly' AND \"DaysMask\" BETWEEN 1 AND 127 AND \"IntervalDays\" IS NULL AND \"AnchorDate\" IS NULL) OR (\"Pattern\" = 'interval' AND \"DaysMask\" = 0 AND \"IntervalDays\" > 0 AND \"IntervalDays\" IS NOT NULL AND \"AnchorDate\" IS NOT NULL AND \"StartDate\" = \"AnchorDate\")");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // A downgrade would erase saved intentions and fabricate dates for undated
            // occurrences. Restore a verified pre-U1 backup instead of a lossy rewrite.
            throw new NotSupportedException("U1 cannot be downgraded without losing user intent. Restore a verified pre-U1 backup with the API stopped.");
        }
    }
}
