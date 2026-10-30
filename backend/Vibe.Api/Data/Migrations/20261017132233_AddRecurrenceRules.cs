using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Vibe.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddRecurrenceRules : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Writers are stopped during the coordinated S1 -> S2 cutover. These are only
            // transient read projections/pins; domain, log, stream and dedup/history survive.
            migrationBuilder.Sql("DELETE FROM \"SyncSnapshotItems\"; DELETE FROM \"SyncSnapshots\";");
            migrationBuilder.DropIndex(
                name: "IX_SyncChanges_UserId_StreamId_OpId",
                table: "SyncChanges");

            migrationBuilder.AddColumn<int>(
                name: "Ordinal",
                table: "SyncChanges",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "RecurrenceRules",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "text", nullable: false),
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DefinitionId = table.Column<Guid>(type: "uuid", nullable: false),
                    DaysMask = table.Column<int>(type: "integer", nullable: false),
                    Timezone = table.Column<string>(type: "text", nullable: false),
                    StartDate = table.Column<DateOnly>(type: "date", nullable: false),
                    EndDate = table.Column<DateOnly>(type: "date", nullable: true),
                    GenerationStartDate = table.Column<DateOnly>(type: "date", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    GeneratedThrough = table.Column<DateOnly>(type: "date", nullable: true),
                    Version = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RecurrenceRules", x => new { x.UserId, x.Id });
                    table.CheckConstraint("CK_RecurrenceRule_Dates", "(\"EndDate\" IS NULL OR \"EndDate\" >= \"StartDate\") AND \"GenerationStartDate\" >= \"StartDate\" AND (\"GeneratedThrough\" IS NULL OR (\"GeneratedThrough\" >= \"GenerationStartDate\" AND (\"EndDate\" IS NULL OR \"GeneratedThrough\" <= \"EndDate\")))");
                    table.CheckConstraint("CK_RecurrenceRule_Days", "\"DaysMask\" BETWEEN 1 AND 127");
                    table.ForeignKey(
                        name: "FK_RecurrenceRules_TaskDefinitions_UserId_DefinitionId",
                        columns: x => new { x.UserId, x.DefinitionId },
                        principalTable: "TaskDefinitions",
                        principalColumns: new[] { "UserId", "Id" },
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "RecurrenceSlots",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "text", nullable: false),
                    RuleId = table.Column<Guid>(type: "uuid", nullable: false),
                    SlotDate = table.Column<DateOnly>(type: "date", nullable: false),
                    OccurrenceId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RecurrenceSlots", x => new { x.UserId, x.RuleId, x.SlotDate });
                    table.ForeignKey(
                        name: "FK_RecurrenceSlots_RecurrenceRules_UserId_RuleId",
                        columns: x => new { x.UserId, x.RuleId },
                        principalTable: "RecurrenceRules",
                        principalColumns: new[] { "UserId", "Id" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_RecurrenceSlots_TaskOccurrences_UserId_OccurrenceId",
                        columns: x => new { x.UserId, x.OccurrenceId },
                        principalTable: "TaskOccurrences",
                        principalColumns: new[] { "UserId", "Id" },
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SyncChanges_UserId_StreamId_OpId_Ordinal",
                table: "SyncChanges",
                columns: new[] { "UserId", "StreamId", "OpId", "Ordinal" },
                unique: true);

            migrationBuilder.AddCheckConstraint(
                name: "CK_SyncChange_Ordinal",
                table: "SyncChanges",
                sql: "\"Ordinal\" >= 0");

            migrationBuilder.CreateIndex(
                name: "IX_RecurrenceRules_UserId_DefinitionId",
                table: "RecurrenceRules",
                columns: new[] { "UserId", "DefinitionId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_RecurrenceRules_UserId_Enabled_Id",
                table: "RecurrenceRules",
                columns: new[] { "UserId", "Enabled", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_RecurrenceSlots_UserId_OccurrenceId",
                table: "RecurrenceSlots",
                columns: new[] { "UserId", "OccurrenceId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "RecurrenceSlots");

            migrationBuilder.DropTable(
                name: "RecurrenceRules");

            migrationBuilder.DropIndex(
                name: "IX_SyncChanges_UserId_StreamId_OpId_Ordinal",
                table: "SyncChanges");

            migrationBuilder.DropCheckConstraint(
                name: "CK_SyncChange_Ordinal",
                table: "SyncChanges");

            migrationBuilder.DropColumn(
                name: "Ordinal",
                table: "SyncChanges");

            migrationBuilder.CreateIndex(
                name: "IX_SyncChanges_UserId_StreamId_OpId",
                table: "SyncChanges",
                columns: new[] { "UserId", "StreamId", "OpId" },
                unique: true);
        }
    }
}
