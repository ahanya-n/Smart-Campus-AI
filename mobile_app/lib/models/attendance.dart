import 'student_summary.dart';

/// Attendance for one subject, from GET /attendance/me.
class AttendanceRecord {
  const AttendanceRecord({
    required this.subjectCode,
    required this.subjectName,
    required this.totalClasses,
    required this.presentClasses,
    required this.absentClasses,
    required this.percentage,
    required this.lowAttendance,
    required this.isDemo,
  });

  final String subjectCode;
  final String subjectName;
  final int totalClasses;
  final int presentClasses;
  final int absentClasses;
  final double percentage;
  final bool lowAttendance;
  final bool isDemo;

  factory AttendanceRecord.fromJson(Map<String, dynamic> json) {
    return AttendanceRecord(
      subjectCode: (json['subject_code'] ?? '').toString(),
      subjectName: (json['subject_name'] ?? '').toString(),
      totalClasses: readInt(json['total_classes']),
      presentClasses: readInt(json['present_classes']),
      absentClasses: readInt(json['absent_classes']),
      percentage: readDouble(json['attendance_percentage']),
      lowAttendance: json['low_attendance'] == true,
      isDemo: json['is_demo'] == true,
    );
  }
}

class AttendanceSummary {
  const AttendanceSummary({
    required this.totalClasses,
    required this.presentClasses,
    required this.absentClasses,
    required this.percentage,
    required this.subjectCount,
    required this.lowAttendanceSubjects,
    required this.threshold,
  });

  final int totalClasses;
  final int presentClasses;
  final int absentClasses;
  final double percentage;
  final int subjectCount;
  final List<String> lowAttendanceSubjects;
  final double threshold;

  factory AttendanceSummary.fromJson(Map<String, dynamic> json) {
    final low = json['low_attendance_subjects'];
    return AttendanceSummary(
      totalClasses: readInt(json['total_classes']),
      presentClasses: readInt(json['present_classes']),
      absentClasses: readInt(json['absent_classes']),
      percentage: readDouble(json['attendance_percentage']),
      subjectCount: readInt(json['subject_count']),
      lowAttendanceSubjects:
          low is List ? low.map((e) => e.toString()).toList() : const [],
      threshold: json['threshold'] is num ? readDouble(json['threshold']) : 75,
    );
  }
}

/// Full response of GET /attendance/me.
class AttendanceReport {
  const AttendanceReport({
    required this.linked,
    required this.isDemo,
    required this.message,
    required this.student,
    required this.summary,
    required this.records,
  });

  /// False when the signed-in account has no matching student record.
  final bool linked;
  final bool isDemo;
  final String? message;
  final StudentSummary? student;
  final AttendanceSummary summary;
  final List<AttendanceRecord> records;

  factory AttendanceReport.fromJson(Map<String, dynamic> json) {
    final summary = json['summary'];
    final records = json['records'];
    return AttendanceReport(
      linked: json['linked'] == true,
      isDemo: json['is_demo'] == true,
      message: json['message']?.toString(),
      student: StudentSummary.fromJson(json['student']),
      summary: AttendanceSummary.fromJson(
          summary is Map<String, dynamic> ? summary : const {}),
      records: records is List
          ? records
              .whereType<Map<String, dynamic>>()
              .map(AttendanceRecord.fromJson)
              .toList()
          : const [],
    );
  }
}
