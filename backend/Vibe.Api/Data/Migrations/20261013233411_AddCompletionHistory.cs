using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Vibe.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddCompletionHistory : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Completions",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "text", nullable: false),
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    OccurrenceId = table.Column<Guid>(type: "uuid", nullable: false),
                    CompletedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    RevokedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    Source = table.Column<string>(type: "text", nullable: false),
                    OccurrenceSnapshotJson = table.Column<string>(type: "jsonb", nullable: false),
                    Version = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Completions", x => new { x.UserId, x.Id });
                    table.CheckConstraint("CK_Completion_ManualSource", "\"Source\" = 'manual'");
                    table.ForeignKey(
                        name: "FK_Completions_TaskOccurrences_UserId_OccurrenceId",
                        columns: x => new { x.UserId, x.OccurrenceId },
                        principalTable: "TaskOccurrences",
                        principalColumns: new[] { "UserId", "Id" },
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "UX_Completions_User_Occurrence_Active",
                table: "Completions",
                columns: new[] { "UserId", "OccurrenceId" },
                unique: true,
                filter: "\"RevokedAtUtc\" IS NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "Completions");
        }
    }
}
