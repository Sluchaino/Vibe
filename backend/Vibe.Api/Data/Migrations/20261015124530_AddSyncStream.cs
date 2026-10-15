using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Vibe.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddSyncStream : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SyncStreams",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "text", nullable: false),
                    StreamId = table.Column<Guid>(type: "uuid", nullable: false),
                    LastSequence = table.Column<long>(type: "bigint", nullable: false),
                    PrunedThrough = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SyncStreams", x => x.UserId);
                    table.UniqueConstraint("AK_SyncStreams_UserId_StreamId", x => new { x.UserId, x.StreamId });
                    table.CheckConstraint("CK_SyncStream_Range", "\"LastSequence\" >= 0 AND \"PrunedThrough\" >= 0 AND \"PrunedThrough\" <= \"LastSequence\"");
                    table.ForeignKey(
                        name: "FK_SyncStreams_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "SyncChanges",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "text", nullable: false),
                    StreamId = table.Column<Guid>(type: "uuid", nullable: false),
                    Sequence = table.Column<long>(type: "bigint", nullable: false),
                    ChangeId = table.Column<Guid>(type: "uuid", nullable: false),
                    OpId = table.Column<Guid>(type: "uuid", nullable: false),
                    ItemJson = table.Column<string>(type: "jsonb", nullable: false),
                    PlanStateJson = table.Column<string>(type: "jsonb", nullable: false),
                    RecordedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SyncChanges", x => new { x.UserId, x.StreamId, x.Sequence });
                    table.CheckConstraint("CK_SyncChange_PositiveSequence", "\"Sequence\" > 0");
                    table.ForeignKey(
                        name: "FK_SyncChanges_OperationResults_UserId_OpId",
                        columns: x => new { x.UserId, x.OpId },
                        principalTable: "OperationResults",
                        principalColumns: new[] { "UserId", "OpId" },
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_SyncChanges_SyncStreams_UserId_StreamId",
                        columns: x => new { x.UserId, x.StreamId },
                        principalTable: "SyncStreams",
                        principalColumns: new[] { "UserId", "StreamId" },
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "SyncSnapshots",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "text", nullable: false),
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    StreamId = table.Column<Guid>(type: "uuid", nullable: false),
                    WatermarkSequence = table.Column<long>(type: "bigint", nullable: false),
                    PlanStateJson = table.Column<string>(type: "jsonb", nullable: false),
                    AsOfCursor = table.Column<string>(type: "text", nullable: false),
                    PageSize = table.Column<int>(type: "integer", nullable: false),
                    CreatedAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ExpiresAtUtc = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SyncSnapshots", x => new { x.UserId, x.Id });
                    table.CheckConstraint("CK_SyncSnapshot_Range", "\"WatermarkSequence\" >= 0 AND \"PageSize\" BETWEEN 1 AND 100 AND \"ExpiresAtUtc\" > \"CreatedAtUtc\"");
                    table.ForeignKey(
                        name: "FK_SyncSnapshots_SyncStreams_UserId_StreamId",
                        columns: x => new { x.UserId, x.StreamId },
                        principalTable: "SyncStreams",
                        principalColumns: new[] { "UserId", "StreamId" },
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "SyncSnapshotItems",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "text", nullable: false),
                    SnapshotId = table.Column<Guid>(type: "uuid", nullable: false),
                    Ordinal = table.Column<int>(type: "integer", nullable: false),
                    ItemJson = table.Column<string>(type: "jsonb", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SyncSnapshotItems", x => new { x.UserId, x.SnapshotId, x.Ordinal });
                    table.CheckConstraint("CK_SyncSnapshotItem_Ordinal", "\"Ordinal\" >= 0");
                    table.ForeignKey(
                        name: "FK_SyncSnapshotItems_SyncSnapshots_UserId_SnapshotId",
                        columns: x => new { x.UserId, x.SnapshotId },
                        principalTable: "SyncSnapshots",
                        principalColumns: new[] { "UserId", "Id" },
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SyncChanges_UserId_OpId",
                table: "SyncChanges",
                columns: new[] { "UserId", "OpId" });

            migrationBuilder.CreateIndex(
                name: "IX_SyncChanges_UserId_StreamId_ChangeId",
                table: "SyncChanges",
                columns: new[] { "UserId", "StreamId", "ChangeId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SyncChanges_UserId_StreamId_OpId",
                table: "SyncChanges",
                columns: new[] { "UserId", "StreamId", "OpId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SyncSnapshots_UserId_ExpiresAtUtc_WatermarkSequence",
                table: "SyncSnapshots",
                columns: new[] { "UserId", "ExpiresAtUtc", "WatermarkSequence" });

            migrationBuilder.CreateIndex(
                name: "IX_SyncSnapshots_UserId_StreamId",
                table: "SyncSnapshots",
                columns: new[] { "UserId", "StreamId" });

            // Existing C1 data is the bootstrap baseline. Do not rewrite entities/results or
            // synthesize history from legacy response bytes; each account starts at zero.
            migrationBuilder.Sql("INSERT INTO \"SyncStreams\" (\"UserId\", \"StreamId\", \"LastSequence\", \"PrunedThrough\") SELECT \"Id\", gen_random_uuid(), 0, 0 FROM \"AspNetUsers\";");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SyncChanges");

            migrationBuilder.DropTable(
                name: "SyncSnapshotItems");

            migrationBuilder.DropTable(
                name: "SyncSnapshots");

            migrationBuilder.DropTable(
                name: "SyncStreams");
        }
    }
}
