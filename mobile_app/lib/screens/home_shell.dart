import 'package:flutter/material.dart';

import '../app_scope.dart';
import 'dashboard_screen.dart';
import 'lost_found_screen.dart';
import 'profile_screen.dart';
import 'student_directory_screen.dart';

/// Signed-in area with role-aware bottom navigation.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  String _selectedDestination = 'home';

  void _select(String destination) =>
      setState(() => _selectedDestination = destination);

  @override
  Widget build(BuildContext context) {
    final auth = AppScope.of(context).auth;
    return ListenableBuilder(
      listenable: auth,
      builder: (context, _) {
        final showLostFound =
            auth.user?.isStudent == true || auth.user?.isAdmin == true;
        final showStudents =
            auth.user?.isFaculty == true || auth.user?.isAdmin == true;
        final children = <Widget>[
          DashboardScreen(
            onOpenStudents: () {
              if (showStudents) _select('students');
            },
            onOpenProfile: () => _select('profile'),
          ),
        ];
        final destinationIds = <String>['home'];
        final destinations = <NavigationDestination>[
          const NavigationDestination(
            icon: Icon(Icons.dashboard_outlined),
            selectedIcon: Icon(Icons.dashboard_rounded),
            label: 'Home',
          ),
        ];
        if (showStudents) {
          children.add(const StudentDirectoryScreen());
          destinationIds.add('students');
          destinations.add(
            const NavigationDestination(
              icon: Icon(Icons.groups_outlined),
              selectedIcon: Icon(Icons.groups_rounded),
              label: 'Students',
            ),
          );
        }
        if (showLostFound) {
          children.add(const LostFoundScreen());
          destinationIds.add('lost-found');
          destinations.add(
            const NavigationDestination(
              icon: Icon(Icons.find_in_page_outlined),
              selectedIcon: Icon(Icons.find_in_page_rounded),
              label: 'Lost & Found',
            ),
          );
        }
        children.add(const ProfileScreen());
        destinationIds.add('profile');
        destinations.add(
          const NavigationDestination(
            icon: Icon(Icons.person_outline_rounded),
            selectedIcon: Icon(Icons.person_rounded),
            label: 'Profile',
          ),
        );
        final activeIndex = destinationIds.indexOf(_selectedDestination);
        final visibleIndex = activeIndex < 0 ? 0 : activeIndex;

        return Scaffold(
          body: IndexedStack(index: visibleIndex, children: children),
          bottomNavigationBar: NavigationBar(
            selectedIndex: visibleIndex,
            labelBehavior: MediaQuery.sizeOf(context).width < 380
                ? NavigationDestinationLabelBehavior.onlyShowSelected
                : NavigationDestinationLabelBehavior.alwaysShow,
            onDestinationSelected: (index) =>
                _select(destinationIds.elementAt(index)),
            destinations: destinations,
          ),
        );
      },
    );
  }
}
