import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../models/student.dart';
import '../services/api_service.dart';
import '../utils/formatters.dart';
import '../widgets/state_views.dart';

/// Lists students from GET /students.
class StudentDirectoryScreen extends StatefulWidget {
  const StudentDirectoryScreen({super.key});

  @override
  State<StudentDirectoryScreen> createState() => _StudentDirectoryScreenState();
}

class _StudentDirectoryScreenState extends State<StudentDirectoryScreen> {
  final _searchController = TextEditingController();

  List<Student>? _students;
  String? _error;
  bool _loading = false;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    final scope = AppScope.read(context);
    try {
      final students = await scope.api.getStudents();
      if (!mounted) return;
      setState(() => _students = students);
    } on ApiException catch (e) {
      if (e.isUnauthorized) {
        await scope.auth.logout();
        return;
      }
      if (!mounted) return;
      if (_students == null) {
        setState(() => _error = e.message);
      } else {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Student Directory'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: TextField(
              controller: _searchController,
              onChanged: (value) => setState(() => _query = value),
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                hintText: 'Search name, registration number, email or course',
                prefixIcon: const Icon(Icons.search_rounded),
                suffixIcon: _query.isEmpty
                    ? null
                    : IconButton(
                        tooltip: 'Clear search',
                        icon: const Icon(Icons.close_rounded),
                        onPressed: () {
                          _searchController.clear();
                          setState(() => _query = '');
                        },
                      ),
              ),
            ),
          ),
          Expanded(child: _buildBody()),
        ],
      ),
    );
  }

  Widget _buildBody() {
    final students = _students;

    if (students == null) {
      if (_error != null) {
        return MessageView(
          icon: Icons.cloud_off_rounded,
          title: "Couldn't load students",
          message: _error!,
          actionLabel: 'Try again',
          onAction: _load,
          isError: true,
        );
      }
      return const LoadingView(message: 'Loading students...');
    }

    final visible = students.where((s) => s.matches(_query)).toList();

    final Widget content;
    if (students.isEmpty) {
      content = const _ScrollableMessage(
        child: MessageView(
          icon: Icons.groups_outlined,
          title: 'No students yet',
          message: 'Student records added on the server will appear here.',
        ),
      );
    } else if (visible.isEmpty) {
      content = _ScrollableMessage(
        child: MessageView(
          icon: Icons.search_off_rounded,
          title: 'No matches',
          message: 'No students match "$_query".',
        ),
      );
    } else {
      content = ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
        itemCount: visible.length + 1,
        separatorBuilder: (_, index) => SizedBox(height: index == 0 ? 4 : 12),
        itemBuilder: (context, index) {
          if (index == 0) {
            return Text(
              _query.isEmpty
                  ? '${students.length} ${students.length == 1 ? 'student' : 'students'}'
                  : '${visible.length} of ${students.length} students',
              style: Theme.of(context).textTheme.labelLarge?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant),
            );
          }
          return StudentCard(student: visible[index - 1]);
        },
      );
    }

    return RefreshIndicator(onRefresh: _load, child: content);
  }
}

/// Lets pull-to-refresh work on empty states.
class _ScrollableMessage extends StatelessWidget {
  const _ScrollableMessage({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) => ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(height: constraints.maxHeight, child: child),
        ],
      ),
    );
  }
}

class StudentCard extends StatelessWidget {
  const StudentCard({super.key, required this.student});

  final Student student;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final name = student.name.isEmpty ? 'Unnamed student' : student.name;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CircleAvatar(
              radius: 26,
              backgroundColor: scheme.primaryContainer,
              child: Text(
                initialsOf(student.name),
                style: theme.textTheme.titleMedium?.copyWith(
                  color: scheme.onPrimaryContainer,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: theme.textTheme.titleMedium
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                  if (student.email.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Icon(Icons.email_outlined,
                            size: 16, color: scheme.onSurfaceVariant),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            student.email,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodyMedium
                                ?.copyWith(color: scheme.onSurfaceVariant),
                          ),
                        ),
                      ],
                    ),
                  ],
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _InfoChip(
                        icon: Icons.badge_outlined,
                        label: student.registrationNumber.isNotEmpty
                            ? student.registrationNumber
                            : student.studentId.isEmpty
                                ? 'No ID'
                                : student.studentId,
                      ),
                      if ((student.course.isNotEmpty
                              ? student.course
                              : student.department)
                          .isNotEmpty)
                        _InfoChip(
                          icon: Icons.apartment_rounded,
                          label: student.course.isNotEmpty
                              ? student.course
                              : student.department,
                        ),
                      if (student.semester.isNotEmpty)
                        _InfoChip(
                          icon: Icons.school_outlined,
                          label: 'Semester ${student.semester}',
                        ),
                      if (student.section.isNotEmpty)
                        _InfoChip(
                          icon: Icons.group_work_outlined,
                          label: 'Section ${student.section}',
                        ),
                      if (student.academicYear.isNotEmpty)
                        _InfoChip(
                          icon: Icons.calendar_today_outlined,
                          label: student.academicYear,
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _InfoChip extends StatelessWidget {
  const _InfoChip({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: scheme.secondaryContainer.withValues(alpha: 0.7),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: scheme.onSecondaryContainer),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: scheme.onSecondaryContainer,
            ),
          ),
        ],
      ),
    );
  }
}
